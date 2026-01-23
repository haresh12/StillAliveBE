require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Resend } = require('resend');
const cron = require('node-cron');
const crypto = require('crypto');

// ============================================
// FIREBASE INITIALIZATION FROM ENV
// ============================================
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
console.log('🔥 Firebase initialized from environment variables');

// ============================================
// RESEND INITIALIZATION
// ============================================
const resend = new Resend(process.env.RESEND_API_KEY);
console.log('📧 Resend initialized');

// ============================================
// EXPRESS APP SETUP
// ============================================
const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// ============================================
// CONSTANTS
// ============================================
const MAX_SQUAD_MEMBERS = 5;
// ✅ REMOVED MAX_WATCHING - UNLIMITED NOW!
const MIN_CHECK_IN_FREQUENCY = 1;
const MAX_CHECK_IN_FREQUENCY = 30;

// ============================================
// HELPER FUNCTIONS
// ============================================

// Generate 6-character code
const generateCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

// 🔥 FIXED: Get existing user or create new one
const getUserByDeviceId = async (deviceId) => {
  if (!deviceId) {
    return { success: false, error: 'Device ID is required' };
  }

  try {
    const userRef = db.collection('users').doc(deviceId);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      // User already exists - return existing data
      return {
        success: true,
        user: { id: deviceId, ...userDoc.data() },
        isNew: false
      };
    }

    // User doesn't exist - create new user
    const userData = {
      deviceId,
      displayName: 'User',
      code: null,
      squadMembers: [],
      checkInFrequency: 1,
      streak: 0,
      totalCheckIns: 0, // ✅ NEW: Track total lifetime check-ins
      lastCheckIn: null,

      // ✅ NEW: how many people are watching THIS user
      watchersCount: 0,

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(userData);
    console.log('✅ New user created with device:', deviceId);

    return {
      success: true,
      user: { id: deviceId, ...userData },
      isNew: true
    };
  } catch (error) {
    console.error('❌ Error in getUserByDeviceId:', error);
    return { success: false, error: error.message };
  }
};

// 🔥 FOR TESTING: 1 day = 2 minutes (FOR PRODUCTION: Change to 24 * 60 * 60 * 1000)
const getCheckInIntervalMs = (frequency) => {
  const days = parseInt(frequency) || 1;
  return days * 2 * 60 * 1000; // 🔥 2 minutes per "day" for testing
  // return days * 24 * 60 * 60 * 1000; // 🔥 USE THIS FOR PRODUCTION
};

// ✅ NEW: safe watchersCount parse (never negative)
const safeWatchersCount = (val) => {
  const n = Number(val || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
};

// ============================================
// 📧 EMAIL FUNCTIONS - BEAUTIFUL & PERSONALIZED
// ============================================

const formatTimeDifference = (milliseconds) => {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return `${seconds} second${seconds !== 1 ? 's' : ''}`;
};

const getPersonalizedMessage = (streak, overdueTime) => {
  const hours = Math.floor(overdueTime / (1000 * 60 * 60));

  if (streak >= 100) {
    return `${streak}-day streak was impressive. This is very unusual behavior for them.`;
  } else if (streak >= 30) {
    return `They had a ${streak}-day streak going. Something might be wrong.`;
  } else if (hours > 48) {
    return `It's been over 2 days. This is serious - please check on them immediately.`;
  } else if (hours > 24) {
    return `More than 24 hours without contact. Time to reach out.`;
  } else {
    return `They're usually very consistent. Worth checking in with them.`;
  }
};

const getSeverityEmoji = (overdueTime) => {
  const hours = Math.floor(overdueTime / (1000 * 60 * 60));
  if (hours > 48) return '🚨';
  if (hours > 24) return '⚠️';
  return '⏰';
};

const sendMissedCheckInEmail = async (user, squadMemberEmail, overdueTime) => {
  try {
    const userName = user.displayName || 'Your friend';
    const firstName = userName.split(' ')[0];
    const streak = user.streak || 0;
    const frequency = user.checkInFrequency || 1;
    const timeOverdue = formatTimeDifference(overdueTime);
    const personalizedMessage = getPersonalizedMessage(streak, overdueTime);
    const severityEmoji = getSeverityEmoji(overdueTime);

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        .email-wrapper {
            max-width: 600px;
            margin: 0 auto;
        }
        .container {
            background-color: #ffffff;
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }
        .header {
            background: linear-gradient(135deg, #FF6B6B 0%, #FF3B30 100%);
            padding: 40px 30px;
            text-align: center;
            position: relative;
        }
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 320"><path fill="rgba(255,255,255,0.1)" d="M0,96L48,112C96,128,192,160,288,160C384,160,480,128,576,112C672,96,768,96,864,112C960,128,1056,160,1152,160C1248,160,1344,128,1392,112L1440,96L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z"></path></svg>') no-repeat bottom;
            background-size: cover;
            opacity: 0.5;
        }
        .header-emoji {
            font-size: 64px;
            margin-bottom: 16px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
        }
        .header h1 {
            margin: 0;
            color: #ffffff;
            font-size: 32px;
            font-weight: 900;
            letter-spacing: -0.5px;
            position: relative;
            z-index: 1;
        }
        .header-subtitle {
            color: rgba(255, 255, 255, 0.95);
            font-size: 16px;
            margin-top: 8px;
            font-weight: 600;
            position: relative;
            z-index: 1;
        }
        .content {
            padding: 40px 30px;
        }
        .alert-box {
            background: linear-gradient(135deg, #FFF5F5 0%, #FFE8E8 100%);
            border-left: 5px solid #FF3B30;
            padding: 24px;
            margin-bottom: 30px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(255, 59, 48, 0.1);
        }
        .alert-box-header {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
        }
        .alert-icon {
            font-size: 28px;
            margin-right: 12px;
        }
        .alert-box h2 {
            margin: 0;
            color: #FF3B30;
            font-size: 22px;
            font-weight: 900;
        }
        .alert-box p {
            margin: 12px 0 0 0;
            color: #333333;
            font-size: 17px;
            line-height: 1.6;
            font-weight: 500;
        }
        .alert-box .highlight {
            color: #FF3B30;
            font-weight: 800;
        }
        .user-card {
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            padding: 28px;
            border-radius: 16px;
            margin-bottom: 30px;
            border: 2px solid #e9ecef;
        }
        .user-card-header {
            display: flex;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 2px solid #dee2e6;
        }
        .user-avatar {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, #FF6B6B 0%, #FF3B30 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            font-weight: 900;
            color: white;
            margin-right: 16px;
            box-shadow: 0 4px 12px rgba(255, 59, 48, 0.3);
        }
        .user-name {
            font-size: 24px;
            font-weight: 900;
            color: #212529;
            margin: 0;
        }
        .user-info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        .info-item {
            background: white;
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        .info-label {
            color: #6c757d;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }
        .info-value {
            color: #212529;
            font-size: 20px;
            font-weight: 900;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .insight-box {
            background: linear-gradient(135deg, #FFF9E6 0%, #FFEDD5 100%);
            border-left: 5px solid #FF9800;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 30px;
        }
        .insight-box p {
            margin: 0;
            color: #333333;
            font-size: 16px;
            line-height: 1.6;
            font-weight: 600;
        }
        .cta-section {
            text-align: center;
            margin: 30px 0;
        }
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #FF6B6B 0%, #FF3B30 100%);
            color: #ffffff !important;
            text-decoration: none;
            padding: 18px 40px;
            border-radius: 14px;
            font-weight: 900;
            font-size: 18px;
            text-align: center;
            box-shadow: 0 8px 20px rgba(255, 59, 48, 0.4);
            transition: all 0.3s ease;
        }
        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 28px rgba(255, 59, 48, 0.5);
        }
        .tips-section {
            background: #f8f9fa;
            padding: 24px;
            border-radius: 12px;
            margin-bottom: 30px;
        }
        .tips-section h3 {
            color: #212529;
            font-size: 18px;
            font-weight: 900;
            margin-bottom: 16px;
        }
        .tips-section ul {
            margin: 0;
            padding-left: 20px;
        }
        .tips-section li {
            color: #495057;
            font-size: 15px;
            line-height: 1.8;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .footer {
            background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
            padding: 32px 30px;
            text-align: center;
            color: white;
        }
        .footer-logo {
            font-size: 24px;
            font-weight: 900;
            margin-bottom: 12px;
            color: white;
        }
        .footer p {
            margin: 8px 0;
            color: rgba(255, 255, 255, 0.8);
            font-size: 14px;
        }
        .footer-links {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid rgba(255, 255, 255, 0.2);
        }
        .footer-links a {
            color: rgba(255, 255, 255, 0.9);
            text-decoration: none;
            margin: 0 12px;
            font-weight: 600;
            font-size: 13px;
        }
        @media only screen and (max-width: 600px) {
            body {
                padding: 10px;
            }
            .content {
                padding: 30px 20px;
            }
            .user-info-grid {
                grid-template-columns: 1fr;
            }
            .header h1 {
                font-size: 26px;
            }
        }
    </style>
</head>
<body>
    <div class="email-wrapper">
        <div class="container">
            <div class="header">
                <div class="header-emoji">${severityEmoji}</div>
                <h1>Still Alive Alert</h1>
                <p class="header-subtitle">Someone needs your attention</p>
            </div>
            
            <div class="content">
                <div class="alert-box">
                    <div class="alert-box-header">
                        <span class="alert-icon">⚠️</span>
                        <h2>Missed Check-In Detected</h2>
                    </div>
                    <p><span class="highlight">${userName}</span> hasn't checked in for <span class="highlight">${timeOverdue}</span> and may need your help.</p>
                </div>
                
                <div class="user-card">
                    <div class="user-card-header">
                        <div class="user-avatar">${firstName.charAt(0).toUpperCase()}</div>
                        <h3 class="user-name">${userName}</h3>
                    </div>
                    <div class="user-info-grid">
                        <div class="info-item">
                            <div class="info-label">Previous Streak</div>
                            <div class="info-value">🔥 ${streak} day${streak !== 1 ? 's' : ''}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Check-in Schedule</div>
                            <div class="info-value">⏱️ Every ${frequency} day${frequency > 1 ? 's' : ''}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Time Overdue</div>
                            <div class="info-value">⏰ ${timeOverdue}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Status</div>
                            <div class="info-value">❌ Missed</div>
                        </div>
                    </div>
                </div>
                
                <div class="insight-box">
                    <p>💡 <strong>Why this matters:</strong> ${personalizedMessage}</p>
                </div>
                
                <div class="tips-section">
                    <h3>🤔 What should you do?</h3>
                    <ul>
                        <li><strong>Reach out immediately</strong> - Send a text, call, or check on ${firstName}</li>
                        <li><strong>Check their usual spots</strong> - Visit or contact mutual friends/family</li>
                        <li><strong>Trust your instincts</strong> - If something feels wrong, it might be</li>
                        <li><strong>Emergency services</strong> - Don't hesitate to call if you're seriously concerned</li>
                    </ul>
                </div>
                
                <p style="color: #6c757d; font-size: 14px; line-height: 1.6; text-align: center; padding: 20px; background: #f8f9fa; border-radius: 12px;">
                    <strong>About Still Alive:</strong><br>
                    ${userName} uses Still Alive to let loved ones know they're safe. You're receiving this alert because you're part of their trusted squad. A missed check-in doesn't always mean emergency, but it's worth checking in with them.
                </p>
            </div>
            
            <div class="footer">
                <div class="footer-logo">🫀 Still Alive</div>
                <p><strong>Stay Connected, Stay Safe</strong></p>
                <p>You received this alert because you're in ${firstName}'s safety squad</p>
                <div class="footer-links">
                    <a href="#">Privacy Policy</a>
                    <a href="#">Manage Alerts</a>
                    <a href="#">Unsubscribe</a>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
        `;

    const { data, error } = await resend.emails.send({
      from: 'Still Alive <onboarding@resend.dev>',
      to: [squadMemberEmail],
      subject: `${severityEmoji} ${userName} missed their check-in - Immediate attention needed`,
      html: emailHtml,
    });

    if (error) {
      console.error('❌ Email send error:', error);
      return { success: false, error };
    }

    console.log(`✅ Email sent to ${squadMemberEmail} about ${userName}`);
    return { success: true, data };
  } catch (error) {
    console.error('❌ Send email error:', error);
    return { success: false, error };
  }
};

// ============================================
// 🔥 CRON JOB: OPTIMIZED FOR SCALE
// ============================================

const checkMissedCheckIns = async () => {
  try {
    console.log('🔍 Checking for missed check-ins...');
    const startTime = Date.now();

    const now = new Date();

    const usersSnapshot = await db
      .collection('users')
      .where('lastCheckIn', '!=', null)
      .get();

    if (usersSnapshot.empty) {
      console.log('ℹ️ No users to check');
      return;
    }

    let totalUsers = 0;
    let usersWithSquad = 0;
    let missedCount = 0;
    let emailsSent = 0;
    let emailsFailed = 0;

    const batch = db.batch();
    const emailPromises = [];

    for (const userDoc of usersSnapshot.docs) {
      totalUsers++;
      const userId = userDoc.id;
      const userData = userDoc.data();

      const squadMembers = userData.squadMembers || [];
      if (squadMembers.length === 0) {
        continue;
      }

      usersWithSquad++;

      const lastCheckIn = userData.lastCheckIn?.toDate();
      if (!lastCheckIn) {
        continue;
      }

      const checkInFrequency = userData.checkInFrequency || 1;
      const intervalMs = getCheckInIntervalMs(checkInFrequency);
      const gracePeriodMs = intervalMs * 2;
      const timeSinceCheckIn = now - lastCheckIn;

      if (timeSinceCheckIn > gracePeriodMs) {
        const overdueTime = timeSinceCheckIn - gracePeriodMs;
        const alertKey = `${userId}_${lastCheckIn.getTime()}`;

        const existingAlert = await db
          .collection('missedCheckInAlerts')
          .doc(alertKey)
          .get();

        if (existingAlert.exists) {
          continue;
        }

        missedCount++;
        console.log(`⚠️ MISSED: ${userData.displayName || 'User'} (overdue: ${formatTimeDifference(overdueTime)})`);

        for (const member of squadMembers) {
          const emailPromise = sendMissedCheckInEmail(userData, member.email, overdueTime)
            .then(result => {
              if (result.success) {
                emailsSent++;
              } else {
                emailsFailed++;
              }
              return result;
            });

          emailPromises.push(emailPromise);
        }

        const alertRef = db.collection('missedCheckInAlerts').doc(alertKey);
        batch.set(alertRef, {
          alertKey,
          userId,
          userName: userData.displayName || 'User',
          lastCheckIn: admin.firestore.Timestamp.fromDate(lastCheckIn),
          alertSentAt: admin.firestore.FieldValue.serverTimestamp(),
          squadMembersNotified: squadMembers.map(m => m.email),
          overdueTime,
          checkInFrequency,
        });
      }
    }

    if (missedCount > 0) {
      await batch.commit();
    }

    await Promise.all(emailPromises);

    const duration = Date.now() - startTime;
    console.log(`\n✅ Check complete in ${duration}ms:`);
    console.log(`   📊 Total users: ${totalUsers}`);
    console.log(`   👥 With squad: ${usersWithSquad}`);
    console.log(`   ⚠️  Missed: ${missedCount}`);
    console.log(`   ✅ Emails sent: ${emailsSent}`);
    console.log(`   ❌ Emails failed: ${emailsFailed}\n`);
  } catch (error) {
    console.error('❌ Check missed check-ins error:', error);
  }
};

cron.schedule('*/5 * * * *', () => {
  console.log('⏰ Running missed check-in cron job...');
  checkMissedCheckIns();
});

setTimeout(() => {
  console.log('🚀 Running initial check...');
  checkMissedCheckIns();
}, 5000);

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.2', // ✅ UPDATED VERSION
    features: {
      emailAlerts: true,
      cronJob: true,
      deviceIdAuth: true,
      firebaseFromEnv: true,
      totalCheckIns: true, // ✅ NEW FEATURE
      streakTracking: true, // ✅ NEW FEATURE
    }
  });
});

// ============================================
// DEVICE AUTH MIDDLEWARE - FIXED
// ============================================

const getDeviceId = async (req, res, next) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: 'Device ID required'
      });
    }

    // Get existing user or create new one if doesn't exist
    const result = await getUserByDeviceId(deviceId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    req.deviceId = deviceId;
    req.user = result.user;
    req.isNewUser = result.isNew;
    next();
  } catch (error) {
    console.error('❌ Device auth error:', error);
    res.status(500).json({ success: false, error: 'Device authentication failed' });
  }
};

// ============================================
// USER ROUTES - OPTIMIZED
// ============================================

app.post('/api/users/me', getDeviceId, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.deviceId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = userDoc.data();

    res.json({
      success: true,
      user: {
        deviceId: req.deviceId,
        displayName: userData.displayName,
        code: userData.code,
        squadMembers: userData.squadMembers || [],
        checkInFrequency: userData.checkInFrequency || 1,
        streak: userData.streak || 0,
        totalCheckIns: userData.totalCheckIns || 0, // ✅ NEW
        lastCheckIn: userData.lastCheckIn,
        createdAt: userData.createdAt,
        watchersCount: safeWatchersCount(userData.watchersCount),
      },
      isNewUser: req.isNewUser || false,
    });
  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user' });
  }
});

app.post('/api/users/update-name', getDeviceId, async (req, res) => {
  try {
    const { displayName } = req.body;

    if (!displayName || displayName.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Display name required' });
    }

    const userRef = db.collection('users').doc(req.deviceId);

    await userRef.update({
      displayName: displayName.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Display name updated:', req.deviceId, '→', displayName);

    const updatedDoc = await userRef.get();
    const userData = updatedDoc.data();

    res.json({
      success: true,
      user: {
        deviceId: req.deviceId,
        displayName: userData.displayName,
        code: userData.code,
        squadMembers: userData.squadMembers || [],
        checkInFrequency: userData.checkInFrequency || 1,
        streak: userData.streak || 0,
        totalCheckIns: userData.totalCheckIns || 0, // ✅ NEW
        lastCheckIn: userData.lastCheckIn,
        watchersCount: safeWatchersCount(userData.watchersCount),
      },
    });
  } catch (error) {
    console.error('❌ Update name error:', error);
    res.status(500).json({ success: false, error: 'Failed to update name' });
  }
});

app.post('/api/users/checkin-frequency', getDeviceId, async (req, res) => {
  try {
    const { frequency } = req.body;

    if (!frequency) {
      return res.status(400).json({ success: false, error: 'Frequency required' });
    }

    const days = parseInt(frequency);

    if (isNaN(days) || days < MIN_CHECK_IN_FREQUENCY || days > MAX_CHECK_IN_FREQUENCY) {
      return res.status(400).json({
        success: false,
        error: `Frequency must be between ${MIN_CHECK_IN_FREQUENCY} and ${MAX_CHECK_IN_FREQUENCY} days`
      });
    }

    const userRef = db.collection('users').doc(req.deviceId);

    await userRef.update({
      checkInFrequency: days,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Check-in frequency updated:', req.deviceId, '→', days, 'days');

    res.json({
      success: true,
      checkInFrequency: days,
      message: `Check-in frequency set to ${days} day${days > 1 ? 's' : ''}`,
    });
  } catch (error) {
    console.error('❌ Update frequency error:', error);
    res.status(500).json({ success: false, error: 'Failed to update frequency' });
  }
});

app.post('/api/users/generate-code', getDeviceId, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.deviceId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (userDoc.data().code) {
      return res.json({
        success: true,
        code: userDoc.data().code,
        message: 'Code already exists',
      });
    }

    let code = generateCode();
    let attempts = 0;

    while (attempts < 10) {
      const existingCode = await db
        .collection('users')
        .where('code', '==', code)
        .get();

      if (existingCode.empty) {
        break;
      }

      code = generateCode();
      attempts++;
    }

    if (attempts >= 10) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate unique code. Please try again.'
      });
    }

    await userRef.update({
      code,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Code generated:', req.deviceId, '→', code);

    res.json({
      success: true,
      code,
    });
  } catch (error) {
    console.error('❌ Generate code error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate code' });
  }
});

// ============================================
// ✅✅✅ FIXED CHECK-IN ROUTE - DUAL TRACKING ✅✅✅
// ============================================

app.post('/api/users/checkin', getDeviceId, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.deviceId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = userDoc.data();
    const now = new Date();
    const lastCheckIn = userData.lastCheckIn?.toDate();
    const checkInFrequency = userData.checkInFrequency || 1;
    const intervalMs = getCheckInIntervalMs(checkInFrequency);

    // ✅ ALWAYS increment total check-ins (lifetime counter)
    const newTotalCheckIns = (userData.totalCheckIns || 0) + 1;

    // ✅ FIXED: Streak logic - properly increment or reset
    let newStreak = userData.streak || 0;

    if (lastCheckIn) {
      const timeSinceLastCheckIn = now - lastCheckIn;

      if (timeSinceLastCheckIn <= intervalMs * 2) {
        // ✅ FIXED: INCREMENT the streak instead of setting to 1
        newStreak = newStreak + 1;
      } else {
        // Reset streak if too much time passed
        newStreak = 1;
      }
    } else {
      // First check-in ever
      newStreak = 1;
    }

    const checkInTimestamp = admin.firestore.Timestamp.fromDate(now);
    const batch = db.batch();

    // Update user with BOTH streak and totalCheckIns
    batch.update(userRef, {
      lastCheckIn: checkInTimestamp,
      streak: newStreak,
      totalCheckIns: newTotalCheckIns, // ✅ NEW
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Log check-in
    const checkinRef = db.collection('checkins').doc();
    batch.set(checkinRef, {
      userId: req.deviceId,
      checkedInAt: checkInTimestamp,
      streak: newStreak,
      totalCheckIns: newTotalCheckIns, // ✅ NEW
    });

    await batch.commit();

    console.log('✅ Check-in:', req.deviceId, '→ Streak:', newStreak, '| Total:', newTotalCheckIns);

    res.json({
      success: true,
      user: {
        deviceId: req.deviceId,
        displayName: userData.displayName,
        code: userData.code,
        squadMembers: userData.squadMembers || [],
        checkInFrequency: userData.checkInFrequency || 1,
        streak: newStreak,
        totalCheckIns: newTotalCheckIns, // ✅ NEW
        lastCheckIn: checkInTimestamp,
        watchersCount: safeWatchersCount(userData.watchersCount),
      },
    });
  } catch (error) {
    console.error('❌ Check-in error:', error);
    res.status(500).json({ success: false, error: 'Failed to check in' });
  }
});

app.post('/api/users/checkin/status', getDeviceId, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.deviceId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = userDoc.data();
    const now = new Date();
    const lastCheckIn = userData.lastCheckIn?.toDate();

    const checkInFrequency = userData.checkInFrequency || 1;
    const intervalMs = getCheckInIntervalMs(checkInFrequency);

    let canCheckIn = true;
    let timeRemaining = 0;

    if (lastCheckIn) {
      const timeSinceLastCheckIn = now - lastCheckIn;

      if (timeSinceLastCheckIn < intervalMs) {
        canCheckIn = false;
        timeRemaining = intervalMs - timeSinceLastCheckIn;
      }
    }

    res.json({
      success: true,
      canCheckIn,
      timeRemaining,
      checkInFrequency,
      lastCheckIn: lastCheckIn?.toISOString() || null,
      streak: userData.streak || 0,
      totalCheckIns: userData.totalCheckIns || 0, // ✅ NEW
    });
  } catch (error) {
    console.error('❌ Get check-in status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get status' });
  }
});

// ============================================
// SQUAD ROUTES
// ============================================

app.post('/api/squad/add-member', getDeviceId, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email required' });
    }

    const userRef = db.collection('users').doc(req.deviceId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = userDoc.data();
    let squadMembers = userData.squadMembers || [];

    if (squadMembers.length >= MAX_SQUAD_MEMBERS) {
      return res.status(400).json({
        success: false,
        error: `Maximum ${MAX_SQUAD_MEMBERS} squad members allowed`
      });
    }

    const emailLower = email.toLowerCase().trim();
    if (squadMembers.find((m) => m.email === emailLower)) {
      return res.status(400).json({
        success: false,
        error: 'This email is already in your squad'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailLower)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    const newMember = {
      id: Date.now().toString(),
      email: emailLower,
      addedAt: new Date().toISOString(),
    };

    squadMembers.push(newMember);

    await userRef.update({
      squadMembers,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Squad member added:', req.deviceId, '→', emailLower);

    res.json({
      success: true,
      member: newMember,
      squadMembers,
    });
  } catch (error) {
    console.error('❌ Add squad member error:', error);
    res.status(500).json({ success: false, error: 'Failed to add squad member' });
  }
});

app.post('/api/squad/members', getDeviceId, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.deviceId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const squadMembers = userDoc.data().squadMembers || [];

    res.json({
      success: true,
      members: squadMembers,
    });
  } catch (error) {
    console.error('❌ Get squad members error:', error);
    res.status(500).json({ success: false, error: 'Failed to get squad members' });
  }
});

app.post('/api/squad/members/:id/remove', getDeviceId, async (req, res) => {
  try {
    const { id } = req.params;

    const userRef = db.collection('users').doc(req.deviceId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    let squadMembers = userDoc.data().squadMembers || [];

    const originalLength = squadMembers.length;
    squadMembers = squadMembers.filter((m) => m.id !== id);

    if (squadMembers.length === originalLength) {
      return res.status(404).json({ success: false, error: 'Squad member not found' });
    }

    await userRef.update({
      squadMembers,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Squad member removed:', req.deviceId, '→ ID:', id);

    res.json({
      success: true,
      message: 'Squad member removed',
      squadMembers,
    });
  } catch (error) {
    console.error('❌ Remove squad member error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove squad member' });
  }
});

// ============================================
// WATCHING ROUTES
// ============================================

app.post('/api/watching/add', async (req, res) => {
  try {
    const { deviceId, code, customName } = req.body;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Device ID required' });
    }

    if (!code) {
      return res.status(400).json({ success: false, error: 'Code required' });
    }

    const codeUpper = code.toUpperCase().trim();

    if (codeUpper.length !== 6) {
      return res.status(400).json({
        success: false,
        error: 'Code must be 6 characters'
      });
    }

    const targetSnapshot = await db
      .collection('users')
      .where('code', '==', codeUpper)
      .limit(1)
      .get();

    if (targetSnapshot.empty) {
      return res.status(404).json({
        success: false,
        error: 'Invalid code. This code does not exist.'
      });
    }

    const targetUser = targetSnapshot.docs[0];
    const targetUserId = targetUser.id;
    const targetUserData = targetUser.data();

    const existingWatch = await db
      .collection('watching')
      .where('watcherId', '==', deviceId)
      .where('targetUserId', '==', targetUserId)
      .get();

    if (!existingWatch.empty) {
      return res.status(400).json({
        success: false,
        error: 'You are already watching this person'
      });
    }

    const watchRef = db.collection('watching').doc();
    const targetUserRef = db.collection('users').doc(targetUserId);

    const watchData = {
      watcherId: deviceId,
      targetUserId,
      targetCode: codeUpper,
      customName: customName?.trim() || targetUserData.displayName || `User ${codeUpper}`,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.runTransaction(async (t) => {
      const targetSnap = await t.get(targetUserRef);

      t.set(watchRef, watchData);

      if (targetSnap.exists) {
        const current = safeWatchersCount(targetSnap.data()?.watchersCount);
        t.update(targetUserRef, {
          watchersCount: current + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    console.log('✅ Watching added:', deviceId, '→', codeUpper);

    res.json({
      success: true,
      watch: {
        id: watchRef.id,
        ...watchData,
        addedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ Add watching error:', error);
    res.status(500).json({ success: false, error: 'Failed to add watching' });
  }
});

app.get('/api/watching/list', async (req, res) => {
  try {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Device ID required' });
    }

    const watchingSnapshot = await db
      .collection('watching')
      .where('watcherId', '==', deviceId)
      .get();

    const watching = [];
    const now = new Date();

    for (const doc of watchingSnapshot.docs) {
      const data = doc.data();

      const targetUserDoc = await db.collection('users').doc(data.targetUserId).get();

      if (!targetUserDoc.exists) {
        continue;
      }

      const targetUser = targetUserDoc.data();
      const lastCheckIn = targetUser?.lastCheckIn?.toDate();

      const checkInFrequency = targetUser?.checkInFrequency || 1;
      const intervalMs = getCheckInIntervalMs(checkInFrequency);

      let status = 'alive';
      let missedSince = null;
      let timeSinceCheckIn = 0;

      if (lastCheckIn) {
        timeSinceCheckIn = now - lastCheckIn;

        if (timeSinceCheckIn > intervalMs) {
          status = 'missed';
          missedSince = lastCheckIn.toISOString();
        }
      } else {
        status = 'missed';
      }

      watching.push({
        id: doc.id,
        code: data.targetCode,
        name: data.customName,
        addedAt: data.addedAt?.toDate()?.toISOString() || new Date().toISOString(),
        status,
        lastCheckIn: lastCheckIn?.toISOString() || null,
        missedSince,
        timeSinceCheckIn,
        checkInFrequency,
        targetUser: {
          uid: data.targetUserId,
          displayName: targetUser?.displayName || 'Unknown User',
          photoURL: targetUser?.photoURL || '',
          streak: targetUser?.streak || 0,
          totalCheckIns: targetUser?.totalCheckIns || 0, // ✅ NEW
        },
      });
    }

    console.log(`✅ Watching list fetched (${deviceId}): ${watching.length} people`);

    res.json({
      success: true,
      watching,
    });
  } catch (error) {
    console.error('❌ Get watching list error:', error);
    res.status(500).json({ success: false, error: 'Failed to get watching list' });
  }
});

app.delete('/api/watching/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Device ID required' });
    }

    const watchRef = db.collection('watching').doc(id);

    // ✅ FIXED TRANSACTION: ALL READS FIRST, THEN ALL WRITES
    await db.runTransaction(async (t) => {
      // ✅ READS FIRST
      const watchDoc = await t.get(watchRef);

      if (!watchDoc.exists) {
        const err = new Error('Watch entry not found');
        err.statusCode = 404;
        throw err;
      }

      const watchData = watchDoc.data();

      if (watchData.watcherId !== deviceId) {
        const err = new Error('Unauthorized. This entry belongs to a different device.');
        err.statusCode = 403;
        throw err;
      }

      const targetUserRef = db.collection('users').doc(watchData.targetUserId);
      const targetSnap = await t.get(targetUserRef);

      // ✅ WRITES AFTER (no more reads after this point)
      t.delete(watchRef);

      if (targetSnap.exists) {
        const current = safeWatchersCount(targetSnap.data()?.watchersCount);
        const next = Math.max(0, current - 1);

        t.update(targetUserRef, {
          watchersCount: next,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    console.log('✅ Stopped watching:', id);

    res.json({
      success: true,
      message: 'Stopped watching',
    });
  } catch (error) {
    const code = error?.statusCode || 500;
    if (code !== 500) {
      return res.status(code).json({ success: false, error: error.message });
    }

    console.error('❌ Delete watching error:', error);
    res.status(500).json({ success: false, error: 'Failed to stop watching' });
  }
});

// ============================================
// ACCOUNT MANAGEMENT
// ============================================

app.post('/api/account/delete', getDeviceId, async (req, res) => {
  try {
    const deviceId = req.deviceId;
    console.log('🗑️ Deleting account for device:', deviceId);

    // ✅ NEW: If this user is WATCHING others, remove those watch docs
    // and decrement watchersCount on the targets.
    const watchingAsWatcherSnap = await db
      .collection('watching')
      .where('watcherId', '==', deviceId)
      .get();

    const cleanupWatcherPromises = watchingAsWatcherSnap.docs.map((doc) => {
      const watchRef = doc.ref;
      return db.runTransaction(async (t) => {
        const watchDoc = await t.get(watchRef);
        if (!watchDoc.exists) return;

        const watchData = watchDoc.data();
        const targetUserRef = db.collection('users').doc(watchData.targetUserId);
        const targetSnap = await t.get(targetUserRef);

        t.delete(watchRef);

        if (targetSnap.exists) {
          const current = safeWatchersCount(targetSnap.data()?.watchersCount);
          const next = Math.max(0, current - 1);
          t.update(targetUserRef, {
            watchersCount: next,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
    });

    await Promise.all(cleanupWatcherPromises);

    // Delete user
    await db.collection('users').doc(deviceId).delete();

    // Delete watching entries where this user is being watched
    const targetSnapshot = await db
      .collection('watching')
      .where('targetUserId', '==', deviceId)
      .get();
    const targetDeletes = targetSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(targetDeletes);

    // Delete checkins
    const checkinsSnapshot = await db
      .collection('checkins')
      .where('userId', '==', deviceId)
      .get();
    const checkinDeletes = checkinsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(checkinDeletes);

    // Delete alerts
    const alertsSnapshot = await db
      .collection('missedCheckInAlerts')
      .where('userId', '==', deviceId)
      .get();
    const alertDeletes = alertsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(alertDeletes);

    console.log('✅ Account deleted for device:', deviceId);

    res.json({
      success: true,
      deleted: {
        user: true,
        watchingEntriesTarget: targetSnapshot.size,
        watchingEntriesWatcher: watchingAsWatcherSnap.size,
        checkins: checkinsSnapshot.size,
        alerts: alertsSnapshot.size,
      },
    });
  } catch (error) {
    console.error('❌ Delete account error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path
  });
});

app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 STILL ALIVE SERVER - DEVICE ID ONLY`);
  console.log(`${'='.repeat(60)}\n`);
  console.log(`📡 Server:          http://localhost:${PORT}`);
  console.log(`📝 Environment:     ${process.env.NODE_ENV || 'development'}`);
  console.log(`📧 Email alerts:    ✅ ENABLED`);
  console.log(`⏰ Cron job:        ✅ Every 5 minutes`);
  console.log(`💰 Cost optimized:  ✅ Batch queries`);
  console.log(`🎨 Email design:    ✅ Ultra personalized`);
  console.log(`⚡ Check-in:        ✅ Optimized (batched)`);
  console.log(`🔐 Auth:            ✅ Device ID only (NO LOGIN)`);
  console.log(`🔧 Fixes:           ✅ No duplicate users`);
  console.log(`🔧 Fixes:           ✅ Return existing data`);
  console.log(`🔥 Firebase:        ✅ Loaded from .env`);
  console.log(`👁️  Watching:       ✅ UNLIMITED (no cap)`);
  console.log(`📊 Tracking:        ✅ Streak + Total Check-ins`); // ✅ NEW
  console.log(`\n📋 API Routes:`);
  console.log(`   👤 User:     POST /api/users/* (requires deviceId in body)`);
  console.log(`   👥 Squad:    POST /api/squad/* (requires deviceId in body)`);
  console.log(`   👁️  Watch:    GET/POST/DELETE /api/watching/*`);
  console.log(`\n${'='.repeat(60)}`);
});

module.exports = app;
