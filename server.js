require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Resend } = require('resend');
const cron = require('node-cron');

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

// Get existing user or create new one
const getUserByDeviceId = async (deviceId) => {
  if (!deviceId) {
    return { success: false, error: 'Device ID is required' };
  }

  try {
    const userRef = db.collection('users').doc(deviceId);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      return {
        success: true,
        user: { id: deviceId, ...userDoc.data() },
        isNew: false
      };
    }

    const userData = {
      deviceId,
      displayName: 'User',
      code: null,
      squadMembers: [],
      checkInFrequency: 1,
      streak: 0,
      totalCheckIns: 0,
      lastCheckIn: null,
      watchersCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(userData);
    console.log('New user created:', deviceId);

    return {
      success: true,
      user: { id: deviceId, ...userData },
      isNew: true
    };
  } catch (error) {
    console.error('Error in getUserByDeviceId:', error);
    return { success: false, error: error.message };
  }
};

// ✅ PRODUCTION MODE - 1 day = 24 hours
const getCheckInIntervalMs = (frequency) => {
  const days = parseInt(frequency) || 1;
  return days * 24 * 60 * 60 * 1000;
};

// Safe watchersCount parse
const safeWatchersCount = (val) => {
  const n = Number(val || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
};

// ============================================
// 📧 EMAIL FUNCTIONS - SIMPLE & VALUABLE
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
            background-color: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }
        .header {
            background: linear-gradient(135deg, #FF6B6B 0%, #FF3B30 100%);
            padding: 40px 30px;
            text-align: center;
        }
        .header-emoji {
            font-size: 56px;
            margin-bottom: 12px;
        }
        .header h1 {
            margin: 0;
            color: #ffffff;
            font-size: 28px;
            font-weight: 900;
        }
        .content {
            padding: 40px 30px;
        }
        .alert-box {
            background: #FFF5F5;
            border-left: 4px solid #FF3B30;
            padding: 20px;
            margin-bottom: 30px;
            border-radius: 8px;
        }
        .alert-box h2 {
            color: #FF3B30;
            font-size: 20px;
            font-weight: 800;
            margin-bottom: 12px;
        }
        .alert-box p {
            color: #333333;
            font-size: 16px;
            line-height: 1.5;
            margin: 0;
        }
        .highlight {
            color: #FF3B30;
            font-weight: 700;
        }
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 30px;
        }
        .info-item {
            background: #F8F9FA;
            padding: 16px;
            border-radius: 8px;
            text-align: center;
        }
        .info-label {
            color: #6c757d;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            margin-bottom: 6px;
        }
        .info-value {
            color: #212529;
            font-size: 18px;
            font-weight: 900;
        }
        .action-box {
            background: #FFF9E6;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        .action-box h3 {
            color: #FF9800;
            font-size: 16px;
            font-weight: 800;
            margin-bottom: 12px;
        }
        .action-box ul {
            margin: 0;
            padding-left: 20px;
        }
        .action-box li {
            color: #333333;
            font-size: 14px;
            line-height: 1.8;
            margin-bottom: 6px;
        }
        .footer {
            background: #2c3e50;
            padding: 24px 30px;
            text-align: center;
            color: rgba(255, 255, 255, 0.9);
        }
        .footer-logo {
            font-size: 20px;
            font-weight: 900;
            margin-bottom: 8px;
            color: white;
        }
        .footer p {
            margin: 6px 0;
            font-size: 13px;
            line-height: 1.5;
        }
        @media only screen and (max-width: 600px) {
            body {
                padding: 10px;
            }
            .content {
                padding: 30px 20px;
            }
            .info-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-emoji">${severityEmoji}</div>
            <h1>${userName} Missed Check-In</h1>
        </div>
        
        <div class="content">
            <div class="alert-box">
                <h2>⚠️ Alert: ${userName} Needs Your Attention</h2>
                <p><span class="highlight">${userName}</span> hasn't checked in for <span class="highlight">${timeOverdue}</span>. Please reach out to make sure they're okay.</p>
            </div>
            
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Previous Streak</div>
                    <div class="info-value">🔥 ${streak} ${streak === 1 ? 'day' : 'days'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Check-in Frequency</div>
                    <div class="info-value">⏱️ ${frequency} ${frequency === 1 ? 'day' : 'days'}</div>
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
            
            <div class="action-box">
                <h3>What You Should Do:</h3>
                <ul>
                    <li><strong>Call or text ${firstName}</strong> right away to check if they're safe</li>
                    <li><strong>Visit them</strong> if they live nearby and don't respond</li>
                    <li><strong>Contact emergency services</strong> if you're seriously concerned</li>
                    <li><strong>Trust your instincts</strong> - you know them best</li>
                </ul>
            </div>
            
            <div style="background: #F8F9FA; padding: 20px; border-radius: 8px; text-align: center;">
                <p style="color: #6c757d; font-size: 13px; line-height: 1.6; margin: 0;">
                    <strong>Why this matters:</strong> ${userName} uses Still Alive to stay accountable. 
                    You're receiving this because they trust you to check on them if something goes wrong.
                    ${streak > 0 ? ` They had a ${streak}-day streak, so this is unusual behavior.` : ''}
                </p>
            </div>
        </div>
        
        <div class="footer">
            <div class="footer-logo">🫀 Still Alive</div>
            <p><strong>Keep Your Loved Ones Safe</strong></p>
            <p>You're in ${firstName}'s trusted safety squad</p>
        </div>
    </div>
</body>
</html>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Still Alive Alerts <alerts@stillalive.app>',
      to: [squadMemberEmail],
      subject: `${severityEmoji} ${userName} missed their check-in - Please check on them`,
      html: emailHtml,
    });

    if (error) {
      console.error('Email send error:', error);
      return { success: false, error };
    }

    console.log(`Email sent to ${squadMemberEmail} about ${userName}`);
    return { success: true, data };
  } catch (error) {
    console.error('Send email error:', error);
    return { success: false, error };
  }
};

// ============================================
// 🔥 CRON JOB: OPTIMIZED FOR PERFORMANCE
// ============================================

const checkMissedCheckIns = async () => {
  try {
    console.log('🔍 Checking for missed check-ins...');
    const startTime = Date.now();

    const now = new Date();

    // ✅ PERFORMANCE: Only fetch users with lastCheckIn
    const usersSnapshot = await db
      .collection('users')
      .where('lastCheckIn', '!=', null)
      .get();

    if (usersSnapshot.empty) {
      console.log('No users to check');
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

      // ✅ PERFORMANCE: Skip users without squad members
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

      // ✅ Check if overdue (beyond grace period)
      if (timeSinceCheckIn > gracePeriodMs) {
        const overdueTime = timeSinceCheckIn - gracePeriodMs;
        const alertKey = `${userId}_${lastCheckIn.getTime()}`;

        // ✅ PERFORMANCE: Check if alert already sent
        const existingAlert = await db
          .collection('missedCheckInAlerts')
          .doc(alertKey)
          .get();

        if (existingAlert.exists) {
          continue;
        }

        missedCount++;
        console.log(`⚠️ MISSED: ${userData.displayName || 'User'} (overdue: ${formatTimeDifference(overdueTime)})`);

        // ✅ Send emails to all squad members
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

        // ✅ Log alert to prevent duplicates
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

    // ✅ PERFORMANCE: Batch write all alerts at once
    if (missedCount > 0) {
      await batch.commit();
    }

    // ✅ PERFORMANCE: Send all emails in parallel
    await Promise.all(emailPromises);

    const duration = Date.now() - startTime;
    console.log(`\n✅ Check complete in ${duration}ms:`);
    console.log(`   Total users: ${totalUsers}`);
    console.log(`   With squad: ${usersWithSquad}`);
    console.log(`   Missed: ${missedCount}`);
    console.log(`   Emails sent: ${emailsSent}`);
    console.log(`   Emails failed: ${emailsFailed}\n`);
  } catch (error) {
    console.error('Check missed check-ins error:', error);
  }
};

// ✅ CRON: RUNS EVERY 1 HOUR (at :00 minutes)
cron.schedule('0 * * * *', () => {
  console.log('⏰ Running hourly missed check-in cron job...');
  checkMissedCheckIns();
});

// ✅ INITIAL CHECK: 5 seconds after server starts
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
    version: '2.1.0',
    features: {
      emailAlerts: true,
      cronJob: true,
      cronInterval: '1 hour',
      deviceIdAuth: true,
      firebaseFromEnv: true,
      totalCheckIns: true,
      streakTracking: true,
    }
  });
});

// ============================================
// DEVICE AUTH MIDDLEWARE
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
    console.error('Device auth error:', error);
    res.status(500).json({ success: false, error: 'Device authentication failed' });
  }
};

// ============================================
// USER ROUTES
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
        totalCheckIns: userData.totalCheckIns || 0,
        lastCheckIn: userData.lastCheckIn,
        createdAt: userData.createdAt,
        watchersCount: safeWatchersCount(userData.watchersCount),
      },
      isNewUser: req.isNewUser || false,
    });
  } catch (error) {
    console.error('Get user error:', error);
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

    console.log('Display name updated:', req.deviceId, '→', displayName);

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
        totalCheckIns: userData.totalCheckIns || 0,
        lastCheckIn: userData.lastCheckIn,
        watchersCount: safeWatchersCount(userData.watchersCount),
      },
    });
  } catch (error) {
    console.error('Update name error:', error);
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

    console.log('Check-in frequency updated:', req.deviceId, '→', days, 'days');

    res.json({
      success: true,
      checkInFrequency: days,
      message: `Check-in frequency set to ${days} day${days > 1 ? 's' : ''}`,
    });
  } catch (error) {
    console.error('Update frequency error:', error);
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

    console.log('Code generated:', req.deviceId, '→', code);

    res.json({
      success: true,
      code,
    });
  } catch (error) {
    console.error('Generate code error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate code' });
  }
});

// ============================================
// CHECK-IN ROUTE - DUAL TRACKING
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

    const newTotalCheckIns = (userData.totalCheckIns || 0) + 1;

    let newStreak = userData.streak || 0;

    if (lastCheckIn) {
      const timeSinceLastCheckIn = now - lastCheckIn;

      if (timeSinceLastCheckIn <= intervalMs * 2) {
        newStreak = newStreak + 1;
      } else {
        newStreak = 1;
      }
    } else {
      newStreak = 1;
    }

    const checkInTimestamp = admin.firestore.Timestamp.fromDate(now);
    const batch = db.batch();

    batch.update(userRef, {
      lastCheckIn: checkInTimestamp,
      streak: newStreak,
      totalCheckIns: newTotalCheckIns,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const checkinRef = db.collection('checkins').doc();
    batch.set(checkinRef, {
      userId: req.deviceId,
      checkedInAt: checkInTimestamp,
      streak: newStreak,
      totalCheckIns: newTotalCheckIns,
    });

    await batch.commit();

    console.log('Check-in:', req.deviceId, '→ Streak:', newStreak, '| Total:', newTotalCheckIns);

    res.json({
      success: true,
      user: {
        deviceId: req.deviceId,
        displayName: userData.displayName,
        code: userData.code,
        squadMembers: userData.squadMembers || [],
        checkInFrequency: userData.checkInFrequency || 1,
        streak: newStreak,
        totalCheckIns: newTotalCheckIns,
        lastCheckIn: checkInTimestamp,
        watchersCount: safeWatchersCount(userData.watchersCount),
      },
    });
  } catch (error) {
    console.error('Check-in error:', error);
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
      totalCheckIns: userData.totalCheckIns || 0,
    });
  } catch (error) {
    console.error('Get check-in status error:', error);
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

    console.log('Squad member added:', req.deviceId, '→', emailLower);

    res.json({
      success: true,
      member: newMember,
      squadMembers,
    });
  } catch (error) {
    console.error('Add squad member error:', error);
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
    console.error('Get squad members error:', error);
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

    console.log('Squad member removed:', req.deviceId, '→ ID:', id);

    res.json({
      success: true,
      message: 'Squad member removed',
      squadMembers,
    });
  } catch (error) {
    console.error('Remove squad member error:', error);
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

    console.log('Watching added:', deviceId, '→', codeUpper);

    res.json({
      success: true,
      watch: {
        id: watchRef.id,
        ...watchData,
        addedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Add watching error:', error);
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
          totalCheckIns: targetUser?.totalCheckIns || 0,
        },
      });
    }

    console.log(`Watching list fetched (${deviceId}): ${watching.length} people`);

    res.json({
      success: true,
      watching,
    });
  } catch (error) {
    console.error('Get watching list error:', error);
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

    await db.runTransaction(async (t) => {
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

    console.log('Stopped watching:', id);

    res.json({
      success: true,
      message: 'Stopped watching',
    });
  } catch (error) {
    const code = error?.statusCode || 500;
    if (code !== 500) {
      return res.status(code).json({ success: false, error: error.message });
    }

    console.error('Delete watching error:', error);
    res.status(500).json({ success: false, error: 'Failed to stop watching' });
  }
});

// ============================================
// ACCOUNT MANAGEMENT
// ============================================

app.post('/api/account/delete', getDeviceId, async (req, res) => {
  try {
    const deviceId = req.deviceId;
    console.log('Deleting account for device:', deviceId);

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

    await db.collection('users').doc(deviceId).delete();

    const targetSnapshot = await db
      .collection('watching')
      .where('targetUserId', '==', deviceId)
      .get();
    const targetDeletes = targetSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(targetDeletes);

    const checkinsSnapshot = await db
      .collection('checkins')
      .where('userId', '==', deviceId)
      .get();
    const checkinDeletes = checkinsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(checkinDeletes);

    const alertsSnapshot = await db
      .collection('missedCheckInAlerts')
      .where('userId', '==', deviceId)
      .get();
    const alertDeletes = alertsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(alertDeletes);

    console.log('Account deleted for device:', deviceId);

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
    console.error('Delete account error:', error);
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
  console.error('Unhandled error:', err);
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
  console.log(`🚀 STILL ALIVE SERVER - PRODUCTION MODE`);
  console.log(`${'='.repeat(60)}\n`);
  console.log(`📡 Server:          http://localhost:${PORT}`);
  console.log(`📝 Environment:     ${process.env.NODE_ENV || 'production'}`);
  console.log(`📧 Email alerts:    ✅ ENABLED`);
  console.log(`⏰ Cron schedule:   ✅ Every 1 hour (at :00)`);
  console.log(`⚡ Check-in:        ✅ PRODUCTION (24h per day)`);
  console.log(`🔐 Auth:            ✅ Device ID only`);
  console.log(`👁️  Watching:       ✅ UNLIMITED`);
  console.log(`📊 Tracking:        ✅ Streak + Total Check-ins`);
  console.log(`⚡ Performance:     ✅ OPTIMIZED`);
  console.log(`\n${'='.repeat(60)}`);
});

module.exports = app;
