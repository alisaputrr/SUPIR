const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isDriver } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Update location (driver only)
router.post('/update-location', verifyToken, isDriver, [
    body('booking_id').isInt().withMessage('Booking ID harus valid'),
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Latitude tidak valid'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Longitude tidak valid'),
    body('status').optional().isIn(['on_way_pickup', 'picked_up', 'on_way_destination', 'arrived']).withMessage('Status tidak valid')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { booking_id, latitude, longitude, status } = req.body;
        const userId = req.user.id;

        // Verify booking belongs to driver
        const bookings = await query(
            `SELECT b.*, d.user_id as driver_user_id 
             FROM bookings b
             JOIN drivers d ON b.driver_id = d.id
             WHERE b.id = ? AND b.status_booking = 'ongoing'`,
            [booking_id]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan atau tidak sedang berjalan'
            });
        }

        if (bookings[0].driver_user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses ke booking ini'
            });
        }

        // Insert tracking data
        const trackingSql = `
            INSERT INTO tracking (booking_id, latitude, longitude, status)
            VALUES (?, ?, ?, ?)
        `;
        
        await query(trackingSql, [booking_id, latitude, longitude, status || null]);

        // Emit real-time location update via Socket.IO
        const io = req.app.get('io');
        if (io) {
            io.to(`booking_${booking_id}`).emit('location_updated', {
                bookingId: booking_id,
                latitude,
                longitude,
                status: status || null,
                timestamp: new Date()
            });
        }

        res.json({
            success: true,
            message: 'Lokasi berhasil diupdate',
            data: {
                booking_id,
                latitude,
                longitude,
                status
            }
        });
    } catch (error) {
        console.error('Update location error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengupdate lokasi'
        });
    }
});

// Get current location of a booking
router.get('/:bookingId/current', verifyToken, async (req, res) => {
    try {
        const { bookingId } = req.params;
        const userId = req.user.id;

        // Verify user has access to this booking
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

        // Check if user is authorized
        if (booking.user_id !== userId && booking.driver_user_id !== userId && req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses ke tracking ini'
            });
        }

        // Get latest tracking data
        const trackingSql = `
            SELECT * FROM tracking
            WHERE booking_id = ?
            ORDER BY created_at DESC
            LIMIT 1
        `;

        const tracking = await query(trackingSql, [bookingId]);

        if (tracking.length === 0) {
            return res.json({
                success: true,
                message: 'Belum ada data tracking',
                data: null
            });
        }

        res.json({
            success: true,
            data: tracking[0]
        });
    } catch (error) {
        console.error('Get current location error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil lokasi'
        });
    }
});

// Get location history
router.get('/:bookingId/history', verifyToken, async (req, res) => {
    try {
        const { bookingId } = req.params;
        const userId = req.user.id;

        // Verify user has access to this booking
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

        // Check if user is authorized
        if (booking.user_id !== userId && booking.driver_user_id !== userId && req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses ke tracking ini'
            });
        }

        // Get all tracking data
        const trackingSql = `
            SELECT * FROM tracking
            WHERE booking_id = ?
            ORDER BY created_at ASC
        `;

        const trackingHistory = await query(trackingSql, [bookingId]);

        res.json({
            success: true,
            data: trackingHistory,
            total: trackingHistory.length
        });
    } catch (error) {
        console.error('Get location history error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat mengambil riwayat lokasi'
        });
    }
});

// Calculate distance and ETA (example using Google Maps API)
router.get('/:bookingId/eta', verifyToken, async (req, res) => {
    try {
        const { bookingId } = req.params;
        const userId = req.user.id;

        // Verify user has access
        const bookings = await query(
            `SELECT b.*, d.user_id as driver_user_id
             FROM bookings b
             JOIN drivers d ON b.driver_id = d.id
             WHERE b.id = ? AND b.status_booking = 'ongoing'`,
            [bookingId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan atau tidak sedang berjalan'
            });
        }

        const booking = bookings[0];

        // Check authorization
        if (booking.user_id !== userId && booking.driver_user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses'
            });
        }

        // Get current location
        const tracking = await query(
            'SELECT * FROM tracking WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1',
            [bookingId]
        );

        if (tracking.length === 0) {
            return res.json({
                success: true,
                message: 'Belum ada data tracking untuk menghitung ETA',
                data: null
            });
        }

        const currentLocation = tracking[0];

        // TODO: Integrate with Google Maps Directions API
        // For now, return mock data
        const mockETA = {
            distance: {
                value: 5000, // meters
                text: '5 km'
            },
            duration: {
                value: 900, // seconds
                text: '15 menit'
            },
            current_location: {
                lat: currentLocation.latitude,
                lng: currentLocation.longitude
            },
            destination: booking.lokasi_tujuan
        };

        res.json({
            success: true,
            data: mockETA
        });
    } catch (error) {
        console.error('Calculate ETA error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat menghitung ETA'
        });
    }
});

// Start tracking (when driver starts journey)
router.post('/:bookingId/start', verifyToken, isDriver, async (req, res) => {
    try {
        const { bookingId } = req.params;
        const { latitude, longitude } = req.body;
        const userId = req.user.id;

        // Verify booking
        const bookings = await query(
            `SELECT b.*, d.user_id as driver_user_id 
             FROM bookings b
             JOIN drivers d ON b.driver_id = d.id
             WHERE b.id = ? AND b.status_booking = 'confirmed'`,
            [bookingId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking tidak ditemukan atau belum dikonfirmasi'
            });
        }

        if (bookings[0].driver_user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses ke booking ini'
            });
        }

        // Update booking status to ongoing
        await query(
            'UPDATE bookings SET status_booking = ? WHERE id = ?',
            ['ongoing', bookingId]
        );

        // Insert first tracking point
        await query(
            'INSERT INTO tracking (booking_id, latitude, longitude, status) VALUES (?, ?, ?, ?)',
            [bookingId, latitude, longitude, 'on_way_pickup']
        );

        // Notify user
        await query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [bookings[0].user_id, 'Driver Berangkat', 'Driver sudah berangkat menuju lokasi jemput Anda', 'booking']
        );

        // Emit real-time notification
        const io = req.app.get('io');
        if (io) {
            io.to(`user_${bookings[0].user_id}`).emit('tracking_started', {
                bookingId,
                message: 'Driver sudah berangkat'
            });
        }

        res.json({
            success: true,
            message: 'Tracking dimulai',
            data: {
                booking_id: bookingId,
                status: 'ongoing'
            }
        });
    } catch (error) {
        console.error('Start tracking error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat memulai tracking'
        });
    }
});

module.exports = router;