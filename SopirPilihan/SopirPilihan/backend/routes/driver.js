const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isDriver, isDriverOrAdmin } = require('../middleware/auth');

// Get all drivers (public)
router.get('/', async (req, res) => {
    try {
        const { kota, jenis_mobil, rating_min, harga_max, search } = req.query;

        let sql = `
            SELECT 
                d.*,
                u.nama_lengkap, u.email, u.nomor_hp, u.foto_profil,
                COALESCE(AVG(r.rating), 5.0) as avg_rating,
                COUNT(DISTINCT r.id) as total_reviews
            FROM drivers d
            JOIN users u ON d.user_id = u.id
            LEFT JOIN reviews r ON d.id = r.driver_id
            WHERE d.status_verifikasi = 'verified' AND u.status = 'active'
        `;

        const params = [];

        // Add filters
        if (kota) {
            sql += ' AND d.kota_domisili = ?';
            params.push(kota);
        }

        if (jenis_mobil) {
            sql += ' AND d.jenis_mobil = ?';
            params.push(jenis_mobil);
        }

        if (rating_min) {
            sql += ' AND d.rating >= ?';
            params.push(parseFloat(rating_min));
        }

        if (harga_max) {
            sql += ' AND d.harga_per_hari <= ?';
            params.push(parseFloat(harga_max));
        }

        if (search) {
            sql += ' AND (u.nama_lengkap LIKE ? OR d.merk_mobil LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        sql += ' GROUP BY d.id ORDER BY d.rating DESC, total_reviews DESC';

        const drivers = await query(sql, params);

        // Parse JSON fields
        drivers.forEach(driver => {
            if (driver.spesialisasi) {
                try {
                    driver.spesialisasi = JSON.parse(driver.spesialisasi);
                } catch (e) {
                    driver.spesialisasi = [];
                }
            }
        });

        res.json({
            success: true,
            data: drivers,
            total: drivers.length
        });
    } catch (error) {
        console.error('Get drivers error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data driver'
        });
    }
});

// Get driver by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const sql = `
            SELECT 
                d.*,
                u.nama_lengkap, u.email, u.nomor_hp, u.foto_profil,
                u.created_at as member_since
            FROM drivers d
            JOIN users u ON d.user_id = u.id
            WHERE d.id = ? AND d.status_verifikasi = 'verified'
        `;

        const drivers = await query(sql, [id]);

        if (drivers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Driver tidak ditemukan'
            });
        }

        const driver = drivers[0];

        // Parse JSON fields
        if (driver.spesialisasi) {
            try {
                driver.spesialisasi = JSON.parse(driver.spesialisasi);
            } catch (e) {
                driver.spesialisasi = [];
            }
        }

        // Get reviews
        const reviewsSql = `
            SELECT 
                r.*,
                u.nama_lengkap, u.foto_profil,
                b.jenis_layanan, b.tanggal_mulai
            FROM reviews r
            JOIN users u ON r.user_id = u.id
            JOIN bookings b ON r.booking_id = b.id
            WHERE r.driver_id = ?
            ORDER BY r.created_at DESC
            LIMIT 10
        `;

        const reviews = await query(reviewsSql, [id]);

        driver.recent_reviews = reviews;

        res.json({
            success: true,
            data: driver
        });
    } catch (error) {
        console.error('Get driver error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data driver'
        });
    }
});

// Update driver profile (driver only)
router.put('/profile', verifyToken, isDriver, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            harga_per_hari, is_available, spesialisasi, deskripsi,
            kota_domisili, merk_mobil, warna_mobil
        } = req.body;

        // Get driver ID
        const driverData = await query('SELECT id FROM drivers WHERE user_id = ?', [userId]);
        
        if (driverData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Data driver tidak ditemukan'
            });
        }

        const driverId = driverData[0].id;

        // Build update query
        const updates = [];
        const params = [];

        if (harga_per_hari !== undefined) {
            updates.push('harga_per_hari = ?');
            params.push(harga_per_hari);
        }

        if (is_available !== undefined) {
            updates.push('is_available = ?');
            params.push(is_available);
        }

        if (spesialisasi) {
            updates.push('spesialisasi = ?');
            params.push(JSON.stringify(spesialisasi));
        }

        if (deskripsi !== undefined) {
            updates.push('deskripsi = ?');
            params.push(deskripsi);
        }

        if (kota_domisili) {
            updates.push('kota_domisili = ?');
            params.push(kota_domisili);
        }

        if (merk_mobil) {
            updates.push('merk_mobil = ?');
            params.push(merk_mobil);
        }

        if (warna_mobil) {
            updates.push('warna_mobil = ?');
            params.push(warna_mobil);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak ada data yang diupdate'
            });
        }

        params.push(driverId);

        const sql = `UPDATE drivers SET ${updates.join(', ')} WHERE id = ?`;
        await query(sql, params);

        res.json({
            success: true,
            message: 'Profil driver berhasil diupdate'
        });
    } catch (error) {
        console.error('Update driver profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengupdate profil'
        });
    }
});

// Get driver statistics (driver only)
router.get('/stats/dashboard', verifyToken, isDriver, async (req, res) => {
    try {
        const userId = req.user.id;

        // Get driver ID
        const driverData = await query('SELECT id FROM drivers WHERE user_id = ?', [userId]);
        
        if (driverData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Data driver tidak ditemukan'
            });
        }

        const driverId = driverData[0].id;

        // Get statistics
        const stats = {};

        // Total bookings
        const bookingsCount = await query(
            'SELECT COUNT(*) as total FROM bookings WHERE driver_id = ?',
            [driverId]
        );
        stats.total_bookings = bookingsCount[0].total;

        // Completed bookings
        const completedCount = await query(
            'SELECT COUNT(*) as total FROM bookings WHERE driver_id = ? AND status_booking = "completed"',
            [driverId]
        );
        stats.completed_bookings = completedCount[0].total;

        // Pending bookings
        const pendingCount = await query(
            'SELECT COUNT(*) as total FROM bookings WHERE driver_id = ? AND status_booking = "pending"',
            [driverId]
        );
        stats.pending_bookings = pendingCount[0].total;

        // Total earnings
        const earnings = await query(
            'SELECT SUM(total_harga) as total FROM bookings WHERE driver_id = ? AND status_booking = "completed" AND payment_status = "paid"',
            [driverId]
        );
        stats.total_earnings = earnings[0].total || 0;

        // This month earnings
        const monthEarnings = await query(
            `SELECT SUM(total_harga) as total FROM bookings 
             WHERE driver_id = ? AND status_booking = "completed" AND payment_status = "paid"
             AND MONTH(tanggal_mulai) = MONTH(CURRENT_DATE()) 
             AND YEAR(tanggal_mulai) = YEAR(CURRENT_DATE())`,
            [driverId]
        );
        stats.month_earnings = monthEarnings[0].total || 0;

        // Average rating
        const rating = await query(
            'SELECT AVG(rating) as avg_rating FROM reviews WHERE driver_id = ?',
            [driverId]
        );
        stats.average_rating = rating[0].avg_rating ? parseFloat(rating[0].avg_rating).toFixed(1) : 5.0;

        // Recent bookings
        const recentBookings = await query(
            `SELECT 
                b.*,
                u.nama_lengkap, u.nomor_hp
            FROM bookings b
            JOIN users u ON b.user_id = u.id
            WHERE b.driver_id = ?
            ORDER BY b.created_at DESC
            LIMIT 5`,
            [driverId]
        );
        stats.recent_bookings = recentBookings;

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Get driver stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil statistik'
        });
    }
});

// Toggle driver availability
router.patch('/availability', verifyToken, isDriver, async (req, res) => {
    try {
        const userId = req.user.id;
        const { is_available } = req.body;

        if (typeof is_available !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'Status availability harus boolean'
            });
        }

        await query(
            'UPDATE drivers SET is_available = ? WHERE user_id = ?',
            [is_available, userId]
        );

        res.json({
            success: true,
            message: `Status availability diubah menjadi ${is_available ? 'tersedia' : 'tidak tersedia'}`,
            is_available
        });
    } catch (error) {
        console.error('Toggle availability error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengubah status'
        });
    }
});

// Get driver reviews
router.get('/:id/reviews', async (req, res) => {
    try {
        const { id } = req.params;
        const { page = 1, limit = 10 } = req.query;

        const offset = (page - 1) * limit;

        const reviewsSql = `
            SELECT 
                r.*,
                u.nama_lengkap, u.foto_profil,
                b.jenis_layanan, b.tanggal_mulai, b.tanggal_selesai
            FROM reviews r
            JOIN users u ON r.user_id = u.id
            JOIN bookings b ON r.booking_id = b.id
            WHERE r.driver_id = ?
            ORDER BY r.created_at DESC
            LIMIT ? OFFSET ?
        `;

        const reviews = await query(reviewsSql, [id, parseInt(limit), offset]);

        // Get total count
        const countSql = 'SELECT COUNT(*) as total FROM reviews WHERE driver_id = ?';
        const countResult = await query(countSql, [id]);
        const total = countResult[0].total;

        res.json({
            success: true,
            data: reviews,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get reviews error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil ulasan'
        });
    }
});

module.exports = router;