const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { verifyToken, isUser, isAdmin } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Setup multer for payment proof upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads/payments';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'payment-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Hanya file gambar (JPEG, PNG) atau PDF yang diperbolehkan'));
        }
    }
});

// Create payment / Upload payment proof
router.post('/', verifyToken, isUser, upload.single('bukti_transfer'), [
    body('booking_id').isInt().withMessage('Booking ID harus valid'),
    body('jumlah').isFloat({ min: 0 }).withMessage('Jumlah harus valid'),
    body('payment_type').isIn(['dp', 'full', 'pelunasan']).withMessage('Tipe pembayaran tidak valid'),
    body('payment_method').isIn(['transfer', 'cash', 'e-wallet']).withMessage('Metode pembayaran tidak valid')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { booking_id, jumlah, payment_type, payment_method } = req.body;
        const userId = req.user.id;
        const buktiTransfer = req.file ? req.file.filename : null;

        // Get booking
        const bookings = await query(
            'SELECT * FROM bookings WHERE id = ? AND user_id = ?',
            [booking_id, userId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan'
            });
        }

        const booking = bookings[0];

        // Validate payment amount
        if (payment_type === 'dp') {
            // DP minimal 30%
            const minDP = booking.total_harga * 0.3;
            if (parseFloat(jumlah) < minDP) {
                return res.status(400).json({
                    success: false,
                    message: `DP minimal ${minDP.toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}`
                });
            }
        } else if (payment_type === 'full' || payment_type === 'pelunasan') {
            // Check remaining payment
            const paidPayments = await query(
                'SELECT SUM(jumlah) as total_paid FROM payments WHERE booking_id = ? AND status_payment = "verified"',
                [booking_id]
            );
            
            const totalPaid = paidPayments[0].total_paid || 0;
            const remaining = booking.total_harga - totalPaid;

            if (parseFloat(jumlah) < remaining) {
                return res.status(400).json({
                    success: false,
                    message: `Sisa pembayaran: ${remaining.toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}`
                });
            }
        }

        // Require bukti transfer for transfer payments
        if (payment_method === 'transfer' && !buktiTransfer) {
            return res.status(400).json({
                success: false,
                message: 'Bukti transfer harus diupload untuk metode transfer'
            });
        }

        // Insert payment
        const paymentResult = await query(
            `INSERT INTO payments (booking_id, jumlah, payment_type, payment_method, bukti_transfer, status_payment)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [booking_id, jumlah, payment_type, payment_method, buktiTransfer, payment_method === 'cash' ? 'verified' : 'pending']
        );

        // Update booking payment status
        let bookingPaymentStatus = 'unpaid';
        
        if (payment_type === 'dp' || payment_type === 'pelunasan') {
            bookingPaymentStatus = payment_type === 'dp' ? 'dp_paid' : 'paid';
            
            // Only update if payment is cash (auto-verified) or will be verified later
            if (payment_method === 'cash') {
                await query(
                    'UPDATE bookings SET payment_status = ? WHERE id = ?',
                    [bookingPaymentStatus, booking_id]
                );
            }
        }

        // Notify driver about payment
        await query(
            `INSERT INTO notifications (user_id, title, message, type)
             SELECT d.user_id, 'Pembayaran Baru', CONCAT('Pembayaran ', ?, ' untuk booking ', ?) as message, 'payment'
             FROM drivers d
             JOIN bookings b ON b.driver_id = d.id
             WHERE b.id = ?`,
            [payment_type, booking.booking_code, booking_id]
        );

        res.status(201).json({
            success: true,
            message: payment_method === 'cash' ? 
                'Pembayaran cash berhasil dicatat' : 
                'Bukti pembayaran berhasil diupload. Menunggu verifikasi admin.',
            data: {
                payment_id: paymentResult.insertId,
                booking_id,
                jumlah,
                status: payment_method === 'cash' ? 'verified' : 'pending'
            }
        });
    } catch (error) {
        console.error('Create payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat memproses pembayaran'
        });
    }
});

// Get payment history for a booking
router.get('/booking/:bookingId', verifyToken, async (req, res) => {
    try {
        const { bookingId } = req.params;
        const userId = req.user.id;
        const userRole = req.user.role;

        // Verify access
        const bookings = await query(
            `SELECT b.*, d.user_id as driver_user_id
             FROM bookings b
             JOIN drivers d ON b.driver_id = d.id
             WHERE b.id = ?`,
            [bookingId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan'
            });
        }

        const booking = bookings[0];

        // Check authorization
        if (userRole !== 'admin' && booking.user_id !== userId && booking.driver_user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses'
            });
        }

        // Get payments
        const payments = await query(
            `SELECT p.*, u.nama_lengkap as verified_by_name
             FROM payments p
             LEFT JOIN users u ON p.verified_by = u.id
             WHERE p.booking_id = ?
             ORDER BY p.tanggal_bayar DESC`,
            [bookingId]
        );

        // Calculate summary
        const totalPaid = payments
            .filter(p => p.status_payment === 'verified')
            .reduce((sum, p) => sum + parseFloat(p.jumlah), 0);

        const remaining = booking.total_harga - totalPaid;

        res.json({
            success: true,
            data: {
                payments,
                summary: {
                    total_booking: booking.total_harga,
                    total_paid: totalPaid,
                    remaining,
                    payment_status: booking.payment_status
                }
            }
        });
    } catch (error) {
        console.error('Get payments error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data pembayaran'
        });
    }
});

// Verify payment (admin only)
router.patch('/:paymentId/verify', verifyToken, isAdmin, [
    body('status').isIn(['verified', 'rejected']).withMessage('Status tidak valid'),
    body('notes').optional().isString()
], async (req, res) => {
    try {
        const { paymentId } = req.params;
        const { status, notes } = req.body;
        const adminId = req.user.id;

        // Get payment
        const payments = await query(
            'SELECT p.*, b.* FROM payments p JOIN bookings b ON p.booking_id = b.id WHERE p.id = ?',
            [paymentId]
        );

        if (payments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Pembayaran tidak ditemukan'
            });
        }

        const payment = payments[0];

        if (payment.status_payment !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Pembayaran sudah diverifikasi sebelumnya'
            });
        }

        await transaction(async (connection) => {
            // Update payment status
            await connection.execute(
                'UPDATE payments SET status_payment = ?, verified_by = ?, verified_at = NOW() WHERE id = ?',
                [status, adminId, paymentId]
            );

            if (status === 'verified') {
                // Update booking payment status
                let bookingPaymentStatus = 'unpaid';
                
                if (payment.payment_type === 'dp') {
                    bookingPaymentStatus = 'dp_paid';
                } else if (payment.payment_type === 'full' || payment.payment_type === 'pelunasan') {
                    // Check if fully paid
                    const [paidPayments] = await connection.execute(
                        `SELECT SUM(jumlah) as total_paid 
                         FROM payments 
                         WHERE booking_id = ? AND status_payment = 'verified' AND id != ?`,
                        [payment.booking_id, paymentId]
                    );
                    
                    const totalPaid = (paidPayments[0].total_paid || 0) + parseFloat(payment.jumlah);
                    
                    if (totalPaid >= payment.total_harga) {
                        bookingPaymentStatus = 'paid';
                    } else {
                        bookingPaymentStatus = 'dp_paid';
                    }
                }

                await connection.execute(
                    'UPDATE bookings SET payment_status = ? WHERE id = ?',
                    [bookingPaymentStatus, payment.booking_id]
                );

                // Notify user
                await connection.execute(
                    'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
                    [
                        payment.user_id,
                        'Pembayaran Terverifikasi',
                        `Pembayaran ${payment.payment_type} untuk booking ${payment.booking_code} telah diverifikasi`,
                        'payment'
                    ]
                );
            } else {
                // Notify user about rejection
                await connection.execute(
                    'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
                    [
                        payment.user_id,
                        'Pembayaran Ditolak',
                        `Pembayaran ditolak. ${notes || 'Silakan upload ulang bukti pembayaran yang benar.'}`,
                        'payment'
                    ]
                );
            }
        });

        // Send real-time notification
        const io = req.app.get('io');
        if (io) {
            io.to(`user_${payment.user_id}`).emit('payment_verified', {
                paymentId,
                status,
                bookingId: payment.booking_id
            });
        }

        res.json({
            success: true,
            message: `Pembayaran berhasil ${status === 'verified' ? 'diverifikasi' : 'ditolak'}`
        });
    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat memverifikasi pembayaran'
        });
    }
});

// Get pending payments (admin only)
router.get('/admin/pending', verifyToken, isAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        const sql = `
            SELECT 
                p.*,
                b.booking_code, b.total_harga,
                u.nama_lengkap as user_name, u.email, u.nomor_hp,
                d.merk_mobil
            FROM payments p
            JOIN bookings b ON p.booking_id = b.id
            JOIN users u ON b.user_id = u.id
            JOIN drivers d ON b.driver_id = d.id
            WHERE p.status_payment = 'pending'
            ORDER BY p.tanggal_bayar DESC
            LIMIT ? OFFSET ?
        `;

        const payments = await query(sql, [parseInt(limit), offset]);

        // Get total count
        const countResult = await query(
            'SELECT COUNT(*) as total FROM payments WHERE status_payment = "pending"'
        );
        const total = countResult[0].total;

        res.json({
            success: true,
            data: payments,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get pending payments error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data pembayaran'
        });
    }
});

// Get payment statistics (admin only)
router.get('/admin/stats', verifyToken, isAdmin, async (req, res) => {
    try {
        const stats = {};

        // Total revenue (verified payments)
        const revenue = await query(
            `SELECT SUM(jumlah) as total FROM payments WHERE status_payment = 'verified'`
        );
        stats.total_revenue = revenue[0].total || 0;

        // This month revenue
        const monthRevenue = await query(
            `SELECT SUM(jumlah) as total FROM payments 
             WHERE status_payment = 'verified'
             AND MONTH(tanggal_bayar) = MONTH(CURRENT_DATE())
             AND YEAR(tanggal_bayar) = YEAR(CURRENT_DATE())`
        );
        stats.month_revenue = monthRevenue[0].total || 0;

        // Pending payments count
        const pending = await query(
            `SELECT COUNT(*) as count FROM payments WHERE status_payment = 'pending'`
        );
        stats.pending_payments = pending[0].count;

        // Payment method breakdown
        const methodBreakdown = await query(
            `SELECT payment_method, COUNT(*) as count, SUM(jumlah) as total
             FROM payments
             WHERE status_payment = 'verified'
             GROUP BY payment_method`
        );
        stats.payment_methods = methodBreakdown;

        // Monthly revenue trend (last 6 months)
        const monthlyTrend = await query(
            `SELECT 
                DATE_FORMAT(tanggal_bayar, '%Y-%m') as month,
                SUM(jumlah) as total
             FROM payments
             WHERE status_payment = 'verified'
             AND tanggal_bayar >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)
             GROUP BY month
             ORDER BY month ASC`
        );
        stats.monthly_trend = monthlyTrend;

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Get payment stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil statistik pembayaran'
        });
    }
});

// Midtrans payment initiation (optional - for online payment)
router.post('/midtrans/initiate', verifyToken, isUser, async (req, res) => {
    try {
        const { booking_id } = req.body;
        const userId = req.user.id;

        // Get booking
        const bookings = await query(
            'SELECT * FROM bookings WHERE id = ? AND user_id = ?',
            [booking_id, userId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan'
            });
        }

        const booking = bookings[0];

        // TODO: Integrate with Midtrans API
        // This is a placeholder for Midtrans integration
        const mockSnapToken = 'MOCK_SNAP_TOKEN_' + Date.now();

        res.json({
            success: true,
            message: 'Payment gateway initiated',
            data: {
                snap_token: mockSnapToken,
                booking_code: booking.booking_code,
                amount: booking.total_harga
            }
        });
    } catch (error) {
        console.error('Midtrans initiate error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat membuat payment gateway'
        });
    }
});

module.exports = router;