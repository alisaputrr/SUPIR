// ============================================
// routes/user.js - User Management Routes
// ============================================

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const bcrypt = require('bcrypt');

// Get user profile
router.get('/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const sql = 'SELECT id, nama_lengkap, email, nomor_hp, alamat, role, foto_profil, created_at FROM users WHERE id = ?';
        const users = await query(sql, [userId]);

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User tidak ditemukan'
            });
        }

        res.json({
            success: true,
            data: users[0]
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil profil'
        });
    }
});

// Update user profile
router.put('/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { nama_lengkap, nomor_hp, alamat } = req.body;

        const updates = [];
        const params = [];

        if (nama_lengkap) {
            updates.push('nama_lengkap = ?');
            params.push(nama_lengkap);
        }

        if (nomor_hp) {
            // Check if phone number already exists
            const existing = await query(
                'SELECT id FROM users WHERE nomor_hp = ? AND id != ?',
                [nomor_hp, userId]
            );

            if (existing.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Nomor HP sudah digunakan'
                });
            }

            updates.push('nomor_hp = ?');
            params.push(nomor_hp);
        }

        if (alamat !== undefined) {
            updates.push('alamat = ?');
            params.push(alamat);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak ada data yang diupdate'
            });
        }

        params.push(userId);
        const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
        await query(sql, params);

        res.json({
            success: true,
            message: 'Profil berhasil diupdate'
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengupdate profil'
        });
    }
});

// Change password
router.put('/change-password', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { old_password, new_password } = req.body;

        if (!old_password || !new_password) {
            return res.status(400).json({
                success: false,
                message: 'Password lama dan baru harus diisi'
            });
        }

        if (new_password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password baru minimal 6 karakter'
            });
        }

        // Get current password
        const users = await query('SELECT password FROM users WHERE id = ?', [userId]);
        
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User tidak ditemukan'
            });
        }

        // Verify old password
        const isValid = await bcrypt.compare(old_password, users[0].password);
        
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Password lama salah'
            });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // Update password
        await query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

        res.json({
            success: true,
            message: 'Password berhasil diubah'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengubah password'
        });
    }
});

// Get notifications
router.get('/notifications', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20, unread_only = false } = req.query;

        let sql = 'SELECT * FROM notifications WHERE user_id = ?';
        const params = [userId];

        if (unread_only === 'true') {
            sql += ' AND is_read = 0';
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), offset);

        const notifications = await query(sql, params);

        // Get unread count
        const countSql = 'SELECT COUNT(*) as total FROM notifications WHERE user_id = ? AND is_read = 0';
        const countResult = await query(countSql, [userId]);
        const unreadCount = countResult[0].total;

        res.json({
            success: true,
            data: notifications,
            unread_count: unreadCount
        });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil notifikasi'
        });
    }
});

// Mark notification as read
router.patch('/notifications/:id/read', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const result = await query(
            'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
            [id, userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'Notifikasi tidak ditemukan'
            });
        }

        res.json({
            success: true,
            message: 'Notifikasi ditandai sudah dibaca'
        });
    } catch (error) {
        console.error('Mark notification read error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan'
        });
    }
});

// Mark all notifications as read
router.patch('/notifications/read-all', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;

        await query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);

        res.json({
            success: true,
            message: 'Semua notifikasi ditandai sudah dibaca'
        });
    } catch (error) {
        console.error('Mark all read error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan'
        });
    }
});

module.exports = router;


// ============================================
// routes/admin.js - Admin Management Routes
// ============================================

const express2 = require('express');
const adminRouter = express2.Router();
const { query: adminQuery } = require('../config/database');
const { verifyToken: adminVerifyToken, isAdmin } = require('../middleware/auth');

// All admin routes require authentication and admin role
adminRouter.use(adminVerifyToken, isAdmin);

// Dashboard statistics
adminRouter.get('/dashboard', async (req, res) => {
    try {
        const stats = {};

        // Total users
        const totalUsers = await adminQuery('SELECT COUNT(*) as count FROM users WHERE role = "user"');
        stats.total_users = totalUsers[0].count;

        // Total drivers
        const totalDrivers = await adminQuery('SELECT COUNT(*) as count FROM drivers WHERE status_verifikasi = "verified"');
        stats.total_drivers = totalDrivers[0].count;

        // Pending driver verifications
        const pendingDrivers = await adminQuery('SELECT COUNT(*) as count FROM drivers WHERE status_verifikasi = "pending"');
        stats.pending_drivers = pendingDrivers[0].count;

        // Total bookings
        const totalBookings = await adminQuery('SELECT COUNT(*) as count FROM bookings');
        stats.total_bookings = totalBookings[0].count;

        // Active bookings
        const activeBookings = await adminQuery('SELECT COUNT(*) as count FROM bookings WHERE status_booking IN ("confirmed", "ongoing")');
        stats.active_bookings = activeBookings[0].count;

        // Completed bookings
        const completedBookings = await adminQuery('SELECT COUNT(*) as count FROM bookings WHERE status_booking = "completed"');
        stats.completed_bookings = completedBookings[0].count;

        // Total revenue
        const revenue = await adminQuery('SELECT SUM(total_harga) as total FROM bookings WHERE status_booking = "completed" AND payment_status = "paid"');
        stats.total_revenue = revenue[0].total || 0;

        // This month revenue
        const monthRevenue = await adminQuery(`
            SELECT SUM(total_harga) as total FROM bookings 
            WHERE status_booking = "completed" AND payment_status = "paid"
            AND MONTH(tanggal_mulai) = MONTH(CURRENT_DATE()) 
            AND YEAR(tanggal_mulai) = YEAR(CURRENT_DATE())
        `);
        stats.month_revenue = monthRevenue[0].total || 0;

        // Pending payments
        const pendingPayments = await adminQuery('SELECT COUNT(*) as count FROM payments WHERE status_payment = "pending"');
        stats.pending_payments = pendingPayments[0].count;

        // Recent bookings
        const recentBookings = await adminQuery(`
            SELECT b.*, u.nama_lengkap as user_name, d.merk_mobil, du.nama_lengkap as driver_name
            FROM bookings b
            JOIN users u ON b.user_id = u.id
            JOIN drivers d ON b.driver_id = d.id
            JOIN users du ON d.user_id = du.id
            ORDER BY b.created_at DESC
            LIMIT 10
        `);
        stats.recent_bookings = recentBookings;

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data dashboard'
        });
    }
});

// Get all users
adminRouter.get('/users', async (req, res) => {
    try {
        const { page = 1, limit = 20, search, role } = req.query;
        const offset = (page - 1) * limit;

        let sql = 'SELECT id, nama_lengkap, email, nomor_hp, role, status, created_at FROM users WHERE 1=1';
        const params = [];

        if (search) {
            sql += ' AND (nama_lengkap LIKE ? OR email LIKE ? OR nomor_hp LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (role) {
            sql += ' AND role = ?';
            params.push(role);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const users = await adminQuery(sql, params);

        // Get total count
        let countSql = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
        const countParams = [];

        if (search) {
            countSql += ' AND (nama_lengkap LIKE ? OR email LIKE ? OR nomor_hp LIKE ?)';
            countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (role) {
            countSql += ' AND role = ?';
            countParams.push(role);
        }

        const countResult = await adminQuery(countSql, countParams);
        const total = countResult[0].total;

        res.json({
            success: true,
            data: users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data user'
        });
    }
});

// Get drivers pending verification
adminRouter.get('/drivers/pending', async (req, res) => {
    try {
        const sql = `
            SELECT d.*, u.nama_lengkap, u.email, u.nomor_hp, u.created_at as registered_at
            FROM drivers d
            JOIN users u ON d.user_id = u.id
            WHERE d.status_verifikasi = 'pending'
            ORDER BY d.created_at ASC
        `;

        const drivers = await adminQuery(sql);

        res.json({
            success: true,
            data: drivers
        });
    } catch (error) {
        console.error('Get pending drivers error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data driver'
        });
    }
});

// Verify driver
adminRouter.patch('/drivers/:id/verify', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, notes } = req.body;
        const adminId = req.user.id;

        if (!['verified', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Status tidak valid'
            });
        }

        // Get driver
        const drivers = await adminQuery(
            'SELECT d.*, u.user_id FROM drivers d JOIN users u ON d.user_id = u.id WHERE d.id = ?',
            [id]
        );

        if (drivers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Driver tidak ditemukan'
            });
        }

        const driver = drivers[0];

        // Update status
        await adminQuery(
            'UPDATE drivers SET status_verifikasi = ? WHERE id = ?',
            [status, id]
        );

        // Create notification
        await adminQuery(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [
                driver.user_id,
                status === 'verified' ? 'Akun Diverifikasi' : 'Verifikasi Ditolak',
                status === 'verified' ? 
                    'Selamat! Akun driver Anda telah diverifikasi. Anda sekarang dapat menerima pesanan.' :
                    `Mohon maaf, verifikasi driver ditolak. ${notes || 'Silakan hubungi admin untuk informasi lebih lanjut.'}`,
                'system'
            ]
        );

        // Log admin activity
        await adminQuery(
            'INSERT INTO admin_logs (admin_id, action, description) VALUES (?, ?, ?)',
            [adminId, 'verify_driver', `${status} driver ID ${id}`]
        );

        res.json({
            success: true,
            message: `Driver berhasil ${status === 'verified' ? 'diverifikasi' : 'ditolak'}`
        });
    } catch (error) {
        console.error('Verify driver error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat memverifikasi driver'
        });
    }
});

// Suspend/Activate user
adminRouter.patch('/users/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const adminId = req.user.id;

        if (!['active', 'suspended'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Status tidak valid'
            });
        }

        await adminQuery('UPDATE users SET status = ? WHERE id = ?', [status, id]);

        // Log admin activity
        await adminQuery(
            'INSERT INTO admin_logs (admin_id, action, description) VALUES (?, ?, ?)',
            [adminId, 'change_user_status', `Set user ${id} status to ${status}`]
        );

        res.json({
            success: true,
            message: `Status user berhasil diubah menjadi ${status}`
        });
    } catch (error) {
        console.error('Change user status error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengubah status user'
        });
    }
});

// Get all bookings
adminRouter.get('/bookings', async (req, res) => {
    try {
        const { page = 1, limit = 20, status, search } = req.query;
        const offset = (page - 1) * limit;

        let sql = `
            SELECT 
                b.*,
                u.nama_lengkap as user_name,
                d.merk_mobil, du.nama_lengkap as driver_name
            FROM bookings b
            JOIN users u ON b.user_id = u.id
            JOIN drivers d ON b.driver_id = d.id
            JOIN users du ON d.user_id = du.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            sql += ' AND b.status_booking = ?';
            params.push(status);
        }

        if (search) {
            sql += ' AND (b.booking_code LIKE ? OR u.nama_lengkap LIKE ? OR du.nama_lengkap LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        sql += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const bookings = await adminQuery(sql, params);

        res.json({
            success: true,
            data: bookings
        });
    } catch (error) {
        console.error('Get bookings error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil data booking'
        });
    }
});

module.exports = adminRouter;