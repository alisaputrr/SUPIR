const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Setup multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads/documents';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
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

// Register User
router.post('/register/user', [
    body('nama_lengkap').notEmpty().withMessage('Nama lengkap harus diisi'),
    body('email').isEmail().withMessage('Email tidak valid'),
    body('nomor_hp').matches(/^08[0-9]{8,11}$/).withMessage('Nomor HP tidak valid'),
    body('password').isLength({ min: 6 }).withMessage('Password minimal 6 karakter'),
    body('alamat').notEmpty().withMessage('Alamat harus diisi')
], async (req, res) => {
    try {
        // Validate input
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { nama_lengkap, email, nomor_hp, password, alamat } = req.body;

        // Check if email or phone already exists
        const checkSql = 'SELECT * FROM users WHERE email = ? OR nomor_hp = ?';
        const existingUsers = await query(checkSql, [email, nomor_hp]);

        if (existingUsers.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Email atau nomor HP sudah terdaftar'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const insertSql = 'INSERT INTO users (nama_lengkap, email, nomor_hp, password, alamat, role) VALUES (?, ?, ?, ?, ?, ?)';
        const result = await query(insertSql, [nama_lengkap, email, nomor_hp, hashedPassword, alamat, 'user']);

        // Generate JWT token
        const token = jwt.sign(
            { userId: result.insertId, role: 'user' },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );

        res.status(201).json({
            success: true,
            message: 'Registrasi berhasil',
            data: {
                userId: result.insertId,
                nama_lengkap,
                email,
                nomor_hp,
                role: 'user',
                token
            }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat registrasi'
        });
    }
});

// Register Driver
router.post('/register/driver', upload.fields([
    { name: 'foto_ktp', maxCount: 1 },
    { name: 'foto_sim', maxCount: 1 },
    { name: 'foto_stnk', maxCount: 1 }
]), [
    body('nama_lengkap').notEmpty().withMessage('Nama lengkap harus diisi'),
    body('email').isEmail().withMessage('Email tidak valid'),
    body('nomor_hp').matches(/^08[0-9]{8,11}$/).withMessage('Nomor HP tidak valid'),
    body('password').isLength({ min: 6 }).withMessage('Password minimal 6 karakter'),
    body('nomor_sim').notEmpty().withMessage('Nomor SIM harus diisi'),
    body('kota_domisili').notEmpty().withMessage('Kota domisili harus diisi'),
    body('jenis_mobil').isIn(['mpv', 'suv', 'minibus', 'sedan']).withMessage('Jenis mobil tidak valid'),
    body('nomor_polisi').notEmpty().withMessage('Nomor polisi harus diisi'),
    body('pengalaman_tahun').isInt({ min: 1 }).withMessage('Pengalaman minimal 1 tahun'),
    body('harga_per_hari').isFloat({ min: 0 }).withMessage('Harga harus valid')
], async (req, res) => {
    try {
        // Validate input
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const {
            nama_lengkap, email, nomor_hp, password, nomor_sim,
            kota_domisili, jenis_mobil, merk_mobil, tahun_kendaraan,
            nomor_polisi, pengalaman_tahun, harga_per_hari, deskripsi
        } = req.body;

        // Check uploaded files
        if (!req.files || !req.files.foto_ktp || !req.files.foto_sim || !req.files.foto_stnk) {
            return res.status(400).json({
                success: false,
                message: 'KTP, SIM, dan STNK harus diupload'
            });
        }

        // Use transaction for data integrity
        const result = await transaction(async (connection) => {
            // Check if email or phone already exists
            const [existingUsers] = await connection.execute(
                'SELECT * FROM users WHERE email = ? OR nomor_hp = ?',
                [email, nomor_hp]
            );

            if (existingUsers.length > 0) {
                throw new Error('Email atau nomor HP sudah terdaftar');
            }

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Insert user
            const [userResult] = await connection.execute(
                'INSERT INTO users (nama_lengkap, email, nomor_hp, password, role) VALUES (?, ?, ?, ?, ?)',
                [nama_lengkap, email, nomor_hp, hashedPassword, 'driver']
            );

            const userId = userResult.insertId;

            // Insert driver details
            const [driverResult] = await connection.execute(
                `INSERT INTO drivers (
                    user_id, nomor_sim, foto_ktp, foto_sim, foto_stnk,
                    kota_domisili, jenis_mobil, merk_mobil, tahun_kendaraan,
                    nomor_polisi, pengalaman_tahun, harga_per_hari, deskripsi,
                    status_verifikasi
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId, nomor_sim,
                    req.files.foto_ktp[0].filename,
                    req.files.foto_sim[0].filename,
                    req.files.foto_stnk[0].filename,
                    kota_domisili, jenis_mobil, merk_mobil || null, tahun_kendaraan,
                    nomor_polisi, pengalaman_tahun, harga_per_hari, deskripsi || null,
                    'pending'
                ]
            );

            return { userId, driverId: driverResult.insertId };
        });

        res.status(201).json({
            success: true,
            message: 'Pendaftaran driver berhasil. Menunggu verifikasi admin.',
            data: {
                userId: result.userId,
                driverId: result.driverId,
                nama_lengkap,
                email,
                status: 'pending'
            }
        });
    } catch (error) {
        console.error('Register driver error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Terjadi kesalahan saat registrasi driver'
        });
    }
});

// Login
router.post('/login', [
    body('email').notEmpty().withMessage('Email/Nomor HP harus diisi'),
    body('password').notEmpty().withMessage('Password harus diisi')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { email, password } = req.body;

        // Find user by email or phone
        const sql = 'SELECT * FROM users WHERE email = ? OR nomor_hp = ?';
        const users = await query(sql, [email, email]);

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Email/Nomor HP atau password salah'
            });
        }

        const user = users[0];

        // Check password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Email/Nomor HP atau password salah'
            });
        }

        // Check if account is active
        if (user.status !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Akun Anda tidak aktif. Silakan hubungi admin.'
            });
        }

        // For drivers, check verification status
        if (user.role === 'driver') {
            const driverSql = 'SELECT status_verifikasi FROM drivers WHERE user_id = ?';
            const drivers = await query(driverSql, [user.id]);
            
            if (drivers.length > 0 && drivers[0].status_verifikasi === 'pending') {
                return res.status(403).json({
                    success: false,
                    message: 'Akun driver Anda masih dalam proses verifikasi'
                });
            }

            if (drivers.length > 0 && drivers[0].status_verifikasi === 'rejected') {
                return res.status(403).json({
                    success: false,
                    message: 'Pendaftaran driver Anda ditolak. Silakan hubungi admin.'
                });
            }
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );

        res.json({
            success: true,
            message: 'Login berhasil',
            data: {
                userId: user.id,
                nama_lengkap: user.nama_lengkap,
                email: user.email,
                nomor_hp: user.nomor_hp,
                role: user.role,
                token
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat login'
        });
    }
});

// Forgot Password
router.post('/forgot-password', [
    body('email').isEmail().withMessage('Email tidak valid')
], async (req, res) => {
    try {
        const { email } = req.body;

        const users = await query('SELECT * FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) {
            // Don't reveal if email exists or not for security
            return res.json({
                success: true,
                message: 'Jika email terdaftar, link reset password akan dikirim'
            });
        }

        // Generate reset token (implement email sending here)
        const resetToken = jwt.sign(
            { userId: users[0].id },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        // TODO: Send email with reset link
        // For now, just return the token
        res.json({
            success: true,
            message: 'Link reset password telah dikirim ke email Anda',
            resetToken // Remove this in production, send via email instead
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan'
        });
    }
});

// Reset Password
router.post('/reset-password', [
    body('token').notEmpty().withMessage('Token harus diisi'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password minimal 6 karakter')
], async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password
        await query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, decoded.userId]);

        res.json({
            success: true,
            message: 'Password berhasil direset'
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(400).json({
            success: false,
            message: 'Token tidak valid atau sudah kadaluarsa'
        });
    }
});

module.exports = router;