const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { verifyToken, isUser, isDriver, isDriverOrAdmin } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Generate unique booking code
function generateBookingCode() {
    const prefix = 'SP';
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${prefix}${year}${month}${random}`;
}

// Create booking (user only)
router.post('/', verifyToken, isUser, [
    body('driver_id').isInt().withMessage('Driver ID harus valid'),
    body('jenis_layanan').isIn(['pengantaran', 'barang', 'tour']).withMessage('Jenis layanan tidak valid'),
    body('tanggal_mulai').isDate().withMessage('Tanggal mulai tidak valid'),
    body('tanggal_selesai').isDate().withMessage('Tanggal selesai tidak valid'),
    body('waktu_mulai').matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('Format waktu tidak valid (HH:MM)'),
    body('lokasi_jemput').notEmpty().withMessage('Lokasi jemput harus diisi'),
    body('lokasi_tujuan').notEmpty().withMessage('Lokasi tujuan harus diisi')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const userId = req.user.id;
        const {
            driver_id, jenis_layanan, tanggal_mulai, tanggal_selesai,
            waktu_mulai, lokasi_jemput, lokasi_tujuan, jumlah_penumpang,
            detail_barang, catatan_khusus
        } = req.body;

        // Validate dates
        const startDate = new Date(tanggal_mulai);
        const endDate = new Date(tanggal_selesai);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (startDate < today) {
            return res.status(400).json({
                success: false,
                message: 'Tanggal mulai tidak boleh di masa lalu'
            });
        }

        if (endDate < startDate) {
            return res.status(400).json({
                success: false,
                message: 'Tanggal selesai harus setelah tanggal mulai'
            });
        }

        const result = await transaction(async (connection) => {
            // Get driver data
            const [drivers] = await connection.execute(
                `SELECT d.*, u.nama_lengkap, u.nomor_hp 
                 FROM drivers d 
                 JOIN users u ON d.user_id = u.id 
                 WHERE d.id = ? AND d.status_verifikasi = 'verified' AND d.is_available = 1`,
                [driver_id]
            );

            if (drivers.length === 0) {
                throw new Error('Driver tidak tersedia');
            }

            const driver = drivers[0];

            // Check if driver has conflicting bookings
            const [conflictingBookings] = await connection.execute(
                `SELECT * FROM bookings 
                 WHERE driver_id = ? 
                 AND status_booking NOT IN ('cancelled', 'completed')
                 AND (
                     (tanggal_mulai BETWEEN ? AND ?) OR
                     (tanggal_selesai BETWEEN ? AND ?) OR
                     (? BETWEEN tanggal_mulai AND tanggal_selesai) OR
                     (? BETWEEN tanggal_mulai AND tanggal_selesai)
                 )`,
                [driver_id, tanggal_mulai, tanggal_selesai, tanggal_mulai, tanggal_selesai, tanggal_mulai, tanggal_selesai]
            );

            if (conflictingBookings.length > 0) {
                throw new Error('Driver sudah dibooking pada tanggal tersebut');
            }

            // Calculate total days and price
            const timeDiff = endDate.getTime() - startDate.getTime();
            const totalHari = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;
            const hargaPerHari = parseFloat(driver.harga_per_hari);
            const totalHarga = totalHari * hargaPerHari;

            // Generate booking code
            const bookingCode = generateBookingCode();

            // Insert booking
            const [bookingResult] = await connection.execute(
                `INSERT INTO bookings (
                    booking_code, user_id, driver_id, jenis_layanan,
                    tanggal_mulai, tanggal_selesai, waktu_mulai,
                    lokasi_jemput, lokasi_tujuan, jumlah_penumpang,
                    detail_barang, catatan_khusus, total_hari,
                    harga_per_hari, total_harga, status_booking
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    bookingCode, userId, driver_id, jenis_layanan,
                    tanggal_mulai, tanggal_selesai, waktu_mulai,
                    lokasi_jemput, lokasi_tujuan, jumlah_penumpang || null,
                    detail_barang || null, catatan_khusus || null, totalHari,
                    hargaPerHari, totalHarga, 'pending'
                ]
            );

            // Create notification for driver
            await connection.execute(
                `INSERT INTO notifications (user_id, title, message, type)
                 VALUES (?, ?, ?, ?)`,
                [
                    driver.user_id,
                    'Booking Baru',
                    `Anda mendapat booking baru dari ${req.user.nama_lengkap} untuk ${jenis_layanan}`,
                    'booking'
                ]
            );

            return {
                bookingId: bookingResult.insertId,
                bookingCode,
                totalHari,
                totalHarga,
                driver: {
                    nama: driver.nama_lengkap,
                    nomor_hp: driver.nomor_hp,
                    mobil: driver.merk_mobil
                }
            };
        });

        // Send real-time notification via Socket.IO
        const io = req.app.get('io');
        if (io) {
            io.to(`user_${result.driver.user_id}`).emit('new_booking', {
                bookingId: result.bookingId,
                bookingCode: result.bookingCode
            });
        }

        res.status(201).json({
            success: true,
            message: 'Booking berhasil dibuat. Menunggu konfirmasi driver.',
            data: result
        });
    } catch (error) {
        console.error('Create booking error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Terjadi kesalahan saat membuat booking'
        });
    }
});

// Get user bookings
router.get('/my-bookings', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { status, page = 1, limit = 10 } = req.query;

        let sql = `
            SELECT 
                b.*,
                d.merk_mobil, d.nomor_polisi, d.jenis_mobil,
                u.nama_lengkap as driver_name, u.nomor_hp as driver_phone, u.foto_profil
            FROM bookings b
            JOIN drivers d ON b.driver_id = d.id
            JOIN users u ON d.user_id = u.id
            WHERE b.user_id = ?
        `;

        const params = [userId];

        if (status) {
            sql += ' AND b.status_booking = ?';
            params.push(status);
        }

        sql += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
        
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), offset);

        const bookings = await query(sql, params);

        // Get total count
        let countSql = 'SELECT COUNT(*) as total FROM bookings WHERE user_id = ?';
        const countParams = [userId];
        
        if (status) {
            countSql += ' AND status_booking = ?';
            countParams.push(status);
        }

        const countResult = await query(countSql, countParams);
        const total = countResult[0].total;

        res.json({
            success: true,
            data: bookings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get bookings error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data booking'
        });
    }
});

// Get driver bookings
router.get('/driver-bookings', verifyToken, isDriver, async (req, res) => {
    try {
        const userId = req.user.id;
        const { status, page = 1, limit = 10 } = req.query;

        // Get driver ID
        const driverData = await query('SELECT id FROM drivers WHERE user_id = ?', [userId]);
        
        if (driverData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Data driver tidak ditemukan'
            });
        }

        const driverId = driverData[0].id;

        let sql = `
            SELECT 
                b.*,
                u.nama_lengkap as user_name, u.nomor_hp as user_phone, u.foto_profil
            FROM bookings b
            JOIN users u ON b.user_id = u.id
            WHERE b.driver_id = ?
        `;

        const params = [driverId];

        if (status) {
            sql += ' AND b.status_booking = ?';
            params.push(status);
        }

        sql += ' ORDER BY b.tanggal_mulai DESC LIMIT ? OFFSET ?';
        
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), offset);

        const bookings = await query(sql, params);

        // Get total count
        let countSql = 'SELECT COUNT(*) as total FROM bookings WHERE driver_id = ?';
        const countParams = [driverId];
        
        if (status) {
            countSql += ' AND status_booking = ?';
            countParams.push(status);
        }

        const countResult = await query(countSql, countParams);
        const total = countResult[0].total;

        res.json({
            success: true,
            data: bookings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get driver bookings error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data booking'
        });
    }
});

// Get booking detail
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const userRole = req.user.role;

        const sql = `
            SELECT 
                b.*,
                d.merk_mobil, d.nomor_polisi, d.jenis_mobil, d.warna_mobil,
                du.id as driver_user_id, du.nama_lengkap as driver_name, 
                du.nomor_hp as driver_phone, du.foto_profil as driver_photo,
                uu.nama_lengkap as user_name, uu.nomor_hp as user_phone,
                uu.foto_profil as user_photo
            FROM bookings b
            JOIN drivers d ON b.driver_id = d.id
            JOIN users du ON d.user_id = du.id
            JOIN users uu ON b.user_id = uu.id
            WHERE b.id = ?
        `;

        const bookings = await query(sql, [id]);

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan'
            });
        }

        const booking = bookings[0];

        // Check authorization
        if (userRole === 'user' && booking.user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses ke booking ini'
            });
        }

        if (userRole === 'driver' && booking.driver_user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses ke booking ini'
            });
        }

        // Get payment history
        const payments = await query(
            'SELECT * FROM payments WHERE booking_id = ? ORDER BY tanggal_bayar DESC',
            [id]
        );

        booking.payments = payments;

        // Get tracking data if ongoing
        if (booking.status_booking === 'ongoing') {
            const tracking = await query(
                'SELECT * FROM tracking WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1',
                [id]
            );
            booking.current_location = tracking[0] || null;
        }

        res.json({
            success: true,
            data: booking
        });
    } catch (error) {
        console.error('Get booking detail error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil detail booking'
        });
    }
});

// Update booking status (driver/admin)
router.patch('/:id/status', verifyToken, isDriverOrAdmin, [
    body('status').isIn(['confirmed', 'ongoing', 'completed', 'cancelled']).withMessage('Status tidak valid'),
    body('reason').optional().isString()
], async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;
        const userId = req.user.id;

        // Get booking
        const bookings = await query(
            `SELECT b.*, d.user_id as driver_user_id 
             FROM bookings b 
             JOIN drivers d ON b.driver_id = d.id 
             WHERE b.id = ?`,
            [id]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan'
            });
        }

        const booking = bookings[0];

        // Check if driver owns this booking (if not admin)
        if (req.user.role === 'driver' && booking.driver_user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses untuk mengubah booking ini'
            });
        }

        // Validate status transitions
        const validTransitions = {
            pending: ['confirmed', 'cancelled'],
            confirmed: ['ongoing', 'cancelled'],
            ongoing: ['completed', 'cancelled'],
            completed: [],
            cancelled: []
        };

        if (!validTransitions[booking.status_booking]?.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Tidak dapat mengubah status dari ${booking.status_booking} ke ${status}`
            });
        }

        // Update status
        await query(
            'UPDATE bookings SET status_booking = ? WHERE id = ?',
            [status, id]
        );

        // Create notification for user
        let notifMessage = '';
        switch (status) {
            case 'confirmed':
                notifMessage = 'Booking Anda telah dikonfirmasi oleh driver';
                break;
            case 'ongoing':
                notifMessage = 'Driver sudah dalam perjalanan';
                break;
            case 'completed':
                notifMessage = 'Perjalanan selesai. Silakan beri rating untuk driver';
                break;
            case 'cancelled':
                notifMessage = `Booking dibatalkan. ${reason || ''}`;
                break;
        }

        await query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [booking.user_id, 'Update Booking', notifMessage, 'booking']
        );

        // Send real-time notification
        const io = req.app.get('io');
        if (io) {
            io.to(`user_${booking.user_id}`).emit('booking_updated', {
                bookingId: id,
                status
            });
        }

        res.json({
            success: true,
            message: 'Status booking berhasil diupdate',
            data: {
                bookingId: id,
                newStatus: status
            }
        });
    } catch (error) {
        console.error('Update booking status error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengupdate status booking'
        });
    }
});

// Cancel booking (user)
router.post('/:id/cancel', verifyToken, isUser, [
    body('reason').notEmpty().withMessage('Alasan pembatalan harus diisi')
], async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        // Get booking
        const bookings = await query(
            'SELECT * FROM bookings WHERE id = ? AND user_id = ?',
            [id, userId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan'
            });
        }

        const booking = bookings[0];

        if (!['pending', 'confirmed'].includes(booking.status_booking)) {
            return res.status(400).json({
                success: false,
                message: 'Booking tidak dapat dibatalkan'
            });
        }

        // Update status
        await query(
            'UPDATE bookings SET status_booking = ?, catatan_khusus = CONCAT(COALESCE(catatan_khusus, ""), "\nDibatalkan: ", ?) WHERE id = ?',
            [reason, id]
        );

        // Notify driver
        await query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [
                booking.driver_id,
                'Booking Dibatalkan',
                `Booking dengan kode ${booking.booking_code} telah dibatalkan oleh customer. Alasan: ${reason}`,
                'booking'
            ]
        );

        res.json({
            success: true,
            message: 'Booking berhasil dibatalkan'
        });
    } catch (error) {
        console.error('Cancel booking error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat membatalkan booking'
        });
    }
});

// Add review
router.post('/:id/review', verifyToken, isUser, [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating harus antara 1-5'),
    body('komentar').optional().isString()
], async (req, res) => {
    try {
        const { id } = req.params;
        const { rating, komentar } = req.body;
        const userId = req.user.id;

        // Check if booking exists and completed
        const bookings = await query(
            'SELECT * FROM bookings WHERE id = ? AND user_id = ? AND status_booking = "completed"',
            [id, userId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan atau belum selesai'
            });
        }

        const booking = bookings[0];

        // Check if already reviewed
        const existingReviews = await query(
            'SELECT * FROM reviews WHERE booking_id = ?',
            [id]
        );

        if (existingReviews.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Anda sudah memberikan ulasan untuk booking ini'
            });
        }

        // Insert review
        await transaction(async (connection) => {
            await connection.execute(
                'INSERT INTO reviews (booking_id, user_id, driver_id, rating, komentar) VALUES (?, ?, ?, ?, ?)',
                [id, userId, booking.driver_id, rating, komentar]
            );

            // Update driver rating
            const [avgRating] = await connection.execute(
                'SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM reviews WHERE driver_id = ?',
                [booking.driver_id]
            );

            await connection.execute(
                'UPDATE drivers SET rating = ?, total_review = ? WHERE id = ?',
                [avgRating[0].avg_rating, avgRating[0].total, booking.driver_id]
            );
        });

        res.status(201).json({
            success: true,
            message: 'Ulasan berhasil ditambahkan'
        });
    } catch (error) {
        console.error('Add review error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat menambahkan ulasan'
        });
    }
});

module.exports = router;