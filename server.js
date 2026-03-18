require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Resend } = require('resend');
const cron = require('node-cron');
const aliveCheckRoutes = require('./aliveCheck');
const referralRoutes = require('./referrals');

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

// REMOVED: Referral routes — referral feature removed
// app.use('/api/referrals', referralRoutes);
app.use('/api/alive-check', aliveCheckRoutes);

// ============================================
// CONSTANTS
// ============================================
const MAX_SQUAD_MEMBERS = 5;
const MIN_CHECK_IN_FREQUENCY = 1;
const MAX_CHECK_IN_FREQUENCY = 30;

// ============================================
// HELPER FUNCTIONS
// ============================================

// ✅ UNIFIED: Generate 6-character code (same as aliveCheck)
const generateCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

// ✅ UNIFIED: Ensure code exists across BOTH collections
const ensureCodeExists = async (deviceId) => {
  try {
    // Check users collection first
    const userDoc = await db.collection('users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().code) {
      return userDoc.data().code;
    }

    // Check aliveChecks collection
    const aliveCheckDoc = await db.collection('aliveChecks').doc(deviceId).get();
    if (aliveCheckDoc.exists && aliveCheckDoc.data().profile?.code) {
      return aliveCheckDoc.data().profile.code;
    }

    // Generate new code
    let code = generateCode();
    let attempts = 0;

    // Ensure uniqueness across BOTH collections
    while (attempts < 10) {
      const [usersQuery, aliveQuery] = await Promise.all([
        db.collection('users').where('code', '==', code).limit(1).get(),
        db.collection('aliveChecks').where('profile.code', '==', code).limit(1).get()
      ]);

      if (usersQuery.empty && aliveQuery.empty) {
        break;
      }

      code = generateCode();
      attempts++;
    }

    return code;
  } catch (error) {
    console.error('Code generation error:', error);
    return generateCode(); // Fallback
  }
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

    // ✅ NEW: Auto-generate code when creating user
    const code = await ensureCodeExists(deviceId);

    // ✅ ALSO sync to aliveChecks if profile exists
    const aliveCheckRef = db.collection('aliveChecks').doc(deviceId);
    const aliveCheckDoc = await aliveCheckRef.get();
    if (aliveCheckDoc.exists && aliveCheckDoc.data().profile && !aliveCheckDoc.data().profile.code) {
      await aliveCheckRef.update({
        'profile.code': code,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`✅ Code synced to aliveChecks: ${deviceId} → ${code}`);
    }

    const userData = {
      deviceId,
      displayName: 'User',
      code, // ✅ Auto-generated!
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
    console.log('New user created with code:', deviceId, '→', code);

    return {
      success: true,
      user: { id: deviceId, ...userData },
      isNew: true
    };
  } catch (error) {
    console.error('Error in getUserByDeviceId:', error);
    return { success: false, error: error.message };
  }
};;

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
// 📧 EMAIL FUNCTIONS - REMOVED (check-in feature removed)
// ============================================

/* REMOVED: Squad/check-in email alert system
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

END REMOVED EMAIL FUNCTIONS */

// ============================================
// 🔥 CRON JOB: REMOVED (check-in feature removed)
// ============================================
/*

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
*/  // END REMOVED CRON JOB

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '3.0.0', // ✅ Bumped for unified code
    features: {
      emailAlerts: true,
      cronJob: true,
      cronInterval: '1 hour',
      deviceIdAuth: true,
      firebaseFromEnv: true,
      totalCheckIns: true,
      streakTracking: true,
      unifiedCode: true, // ✅ NEW
      aliveCheckIntegration: true, // ✅ NEW
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

app.get('/api/version-check', async (req, res) => {
  try {
    console.log('🔍 Version check API called');

    // ✅ Fetch from Firestore appConfig/versionControl
    const versionDoc = await db.collection('appConfig').doc('versionControl').get();

    if (!versionDoc.exists) {
      console.log('⚠️ No version config found in Firestore');
      return res.json({
        success: true,
        versionControl: null
      });
    }

    const versionData = versionDoc.data();
    console.log('✅ Version config found:', versionData.minimumVersion);

    res.json({
      success: true,
      versionControl: {
        minimumVersion: versionData.minimumVersion,
        latestVersion: versionData.latestVersion,
        forceUpdate: versionData.forceUpdate,
        updateMessages: versionData.updateMessages,
        appStoreUrl: versionData.appStoreUrl
      }
    });

  } catch (error) {
    console.error('❌ Version check error:', error);
    res.json({
      success: false,
      versionControl: null,
      error: error.message
    });
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

/* REMOVED: Check-in frequency — check-in feature removed
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
*/  // END REMOVED checkin-frequency

// ✅ UNIFIED: Generate code and sync to BOTH collections
app.post('/api/users/generate-code', getDeviceId, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.deviceId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Check if code already exists
    if (userDoc.data().code) {
      return res.json({
        success: true,
        code: userDoc.data().code,
        message: 'Code already exists',
      });
    }

    // ✅ Generate unified code
    const code = await ensureCodeExists(req.deviceId);

    // ✅ Save to users collection
    await userRef.update({
      code,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ Sync to aliveChecks collection if profile exists
    const aliveCheckRef = db.collection('aliveChecks').doc(req.deviceId);
    const aliveCheckDoc = await aliveCheckRef.get();

    if (aliveCheckDoc.exists && aliveCheckDoc.data().profile) {
      await aliveCheckRef.update({
        'profile.code': code,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Code synced to aliveChecks: ${req.deviceId} → ${code}`);
    }

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
// CHECK-IN ROUTES - REMOVED (check-in feature removed)
// ============================================

/* REMOVED: check-in and check-in status routes
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
*/  // END REMOVED check-in routes

// ============================================
// SQUAD ROUTES - REMOVED (check-in feature removed)
// ============================================

/*

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
*/  // END REMOVED squad routes

// ============================================
// WATCHING ROUTES - REMOVED (check-in feature removed)
// ============================================

/*

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

    // ✅ Search ONLY in users collection (Still Alive daily check-ins)
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

    console.log('Watching added (Daily Check-in):', deviceId, '→', codeUpper);

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

    console.log(`Watching list fetched (Daily Check-in) (${deviceId}): ${watching.length} people`);

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

    console.log('Stopped watching (Daily Check-in):', id);

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
*/  // END REMOVED watching routes

// ============================================
// ACCOUNT MANAGEMENT ✅
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
// PULSE CHALLENGES
// ============================================

const STATIC_CHALLENGES = [
  {
    id: 'c2', emoji: '🌙', duration: '30 DAYS',
    title: '30-Day Momentum Build',
    tagline: 'The most popular starting point.',
    benefit: 'Most people quit before day 21. You won\'t. In 30 days your Alive Score reveals exactly which pillar has been quietly holding the rest of you back — and you\'ll finally know where to focus.',
    baseSeed: 57204,
  },
  {
    id: 'c5', emoji: '⚡', duration: '60 DAYS',
    title: '60-Day Deep Rewire',
    tagline: 'Where real patterns finally surface.',
    benefit: 'Two months strips away the excuses. Your actual patterns show up in the data — not the ones you think you have. The gap between your strongest and weakest pillar starts closing. People around you notice something is different.',
    baseSeed: 31847,
  },
  {
    id: 'c3', emoji: '🏆', duration: '90 DAYS',
    title: '90-Day Baseline Shift',
    tagline: 'Your new normal — permanently.',
    benefit: 'This is the point of no return. What used to drain you starts losing its grip. Things that once felt heavy become automatic. Your emotional baseline moves — and it doesn\'t come back down.',
    baseSeed: 79312,
  },
  {
    id: 'c4', emoji: '🌟', duration: '1 YEAR',
    title: '1-Year Total Transformation',
    tagline: 'The long game. The real one.',
    benefit: 'Most people overestimate what they can do in a week. They catastrophically underestimate what they can do in a year. 8 in 10 people who finish this say they don\'t recognise their old self.',
    baseSeed: 81097,
  },
];

// GET /api/pulse/challenges — list all challenges with live enroll counts
app.get('/api/pulse/challenges', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || null;
    const challenges = await Promise.all(
      STATIC_CHALLENGES.map(async (ch) => {
        // Get total enroll count from Firestore (falls back to seed)
        let enrollCount = ch.baseSeed;
        try {
          const countDoc = await db.collection('challengeEnrollments').doc(ch.id).get();
          if (countDoc.exists) enrollCount = ch.baseSeed + (countDoc.data().count || 0);
        } catch (_) { }

        // Check if this device is enrolled
        let enrolled = false;
        if (deviceId) {
          try {
            const userEnroll = await db.collection('challengeEnrollments')
              .doc(ch.id).collection('members').doc(deviceId).get();
            enrolled = userEnroll.exists;
          } catch (_) { }
        }

        return { ...ch, enrollCount, enrolled };
      })
    );

    res.json({ success: true, challenges });
  } catch (error) {
    console.error('Get challenges error:', error);
    res.status(500).json({ success: false, error: 'Failed to load challenges' });
  }
});

// POST /api/pulse/challenges/enroll — enroll a device in a challenge
app.post('/api/pulse/challenges/enroll', getDeviceId, async (req, res) => {
  try {
    const deviceId = req.deviceId;
    const { challengeId } = req.body;

    if (!challengeId) return res.status(400).json({ success: false, error: 'challengeId required' });

    const challenge = STATIC_CHALLENGES.find(c => c.id === challengeId);
    if (!challenge) return res.status(404).json({ success: false, error: 'Challenge not found' });

    const challengeRef = db.collection('challengeEnrollments').doc(challengeId);
    const memberRef = challengeRef.collection('members').doc(deviceId);

    const alreadyEnrolled = await memberRef.get();
    if (!alreadyEnrolled.exists) {
      // Atomically increment count and add member
      await db.runTransaction(async (t) => {
        const countDoc = await t.get(challengeRef);
        const currentCount = countDoc.exists ? (countDoc.data().count || 0) : 0;
        t.set(challengeRef, { count: currentCount + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        t.set(memberRef, { enrolledAt: admin.firestore.FieldValue.serverTimestamp(), deviceId });
      });
    }

    // Return updated count
    const updatedDoc = await challengeRef.get();
    const liveCount = challenge.baseSeed + (updatedDoc.exists ? updatedDoc.data().count || 0 : 1);

    res.json({ success: true, challengeId, enrollCount: liveCount });
  } catch (error) {
    console.error('Enroll challenge error:', error);
    res.status(500).json({ success: false, error: 'Failed to enroll' });
  }
});

// POST /api/pulse/challenges/log-activity
// Called after each pillar check-in to record pillar count for that day
app.post('/api/pulse/challenges/log-activity', getDeviceId, async (req, res) => {
  try {
    const deviceId = req.deviceId;
    const { pillarCount } = req.body; // 0-4

    if (pillarCount == null) {
      return res.status(400).json({ success: false, error: 'pillarCount required' });
    }

    // Find which challenge this device is enrolled in
    let enrolledChallengeId = null;
    for (const ch of STATIC_CHALLENGES) {
      const memberRef = db.collection('challengeEnrollments')
        .doc(ch.id).collection('members').doc(deviceId);
      const snap = await memberRef.get();
      if (snap.exists) { enrolledChallengeId = ch.id; break; }
    }

    if (!enrolledChallengeId) {
      return res.json({ success: false, error: 'Not enrolled in any challenge' });
    }

    // Store today's activity: key = YYYY-MM-DD
    const today = new Date().toISOString().slice(0, 10);
    const activityRef = db
      .collection('challengeActivity')
      .doc(`${deviceId}_${enrolledChallengeId}`)
      .collection('days')
      .doc(today);

    await activityRef.set({
      date: today,
      pillarCount: Math.min(4, Math.max(0, parseInt(pillarCount) || 0)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({ success: true, date: today, pillarCount });
  } catch (error) {
    console.error('Log activity error:', error);
    res.status(500).json({ success: false, error: 'Failed to log activity' });
  }
});

// GET /api/pulse/challenges/progress?deviceId=X
// Returns dot grid: enrolledChallengeId, enrolledAt, days array [{date, pillarCount}]
app.get('/api/pulse/challenges/progress', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });

    // Find enrolled challenge
    let enrolledChallengeId = null;
    let enrolledAt = null;
    for (const ch of STATIC_CHALLENGES) {
      const memberRef = db.collection('challengeEnrollments')
        .doc(ch.id).collection('members').doc(deviceId);
      const snap = await memberRef.get();
      if (snap.exists) {
        enrolledChallengeId = ch.id;
        enrolledAt = snap.data().enrolledAt?.toDate()?.toISOString() || null;
        break;
      }
    }

    if (!enrolledChallengeId) {
      return res.json({ success: true, enrolled: false, days: [] });
    }

    // Fetch all activity days
    const activitySnap = await db
      .collection('challengeActivity')
      .doc(`${deviceId}_${enrolledChallengeId}`)
      .collection('days')
      .orderBy('date', 'asc')
      .get();

    const days = activitySnap.docs.map(d => ({
      date: d.data().date,
      pillarCount: d.data().pillarCount || 0,
    }));

    res.json({
      success: true,
      enrolled: true,
      challengeId: enrolledChallengeId,
      enrolledAt,
      days,
    });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ success: false, error: 'Failed to get progress' });
  }
});
// ════════════════════════════════════════════
// MIRROR — Daily Emotional Check-in
// ════════════════════════════════════════════
const { OpenAI } = require('openai');
const mirrorOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MIRROR_SYSTEM_PROMPT = `You are Mirror. One job: make the person feel completely heard. Nothing else.

Voice: the one friend who tells you the truth, not the one who comforts you. Raw, direct, human.

Rules (never break these):
- Exactly 2 sentences. Short ones. End there.
- Sentence 1: use their exact words or a specific detail from what they wrote. Do not paraphrase. Do not ignore their note.
- Sentence 2: one honest, specific observation about today. A fact, not comfort.
- Good sentence 2 examples: "That's a heavy one to carry." / "You got through it anyway." / "That kind of day leaves a mark." / "That's worth more than you're giving it." / "You showed up anyway."
- Write like a human texting. Short. Direct. No filler.
- BANNED (never use): it seems, it appears, navigating, understandable, it sounds like, it's clear, I can see, keep going, hang in there, I understand, that must be, I hear you, silver lining, proud of you, well done, you're doing great, remember to, make sure to
- NEVER give advice. NEVER suggest next steps. NEVER add encouragement or hope.
- No emojis. No hashtags. Write in second person ("You said X. That's Y."). Two sentences. Stop.`;

const MOOD_LABELS = { 1: 'Rough', 2: 'Okay', 3: 'Good', 4: 'Thriving' };

// Follow-up purpose: understand how they PROCESSED the emotion after.
// Rough → how did they cope/get through it?
// Okay  → how did they sit with it or shake it?
// Good  → did they actually enjoy/celebrate it?
// Thriving → did they let themselves fully have it?
const FOLLOW_UP_POOLS = {
  1: [
    'How did you get through the rest of that day?',
    'What did you do with the weight of it?',
    'Did anything help, or did you just push through?',
    'How did you handle it in the end?',
    'Did you let yourself sit with it, or distract?',
  ],
  2: [
    'Did you just let it pass, or try to shake it?',
    'What did you end up doing with the rest of the day?',
    'Did you do anything to try and shift the vibe?',
    'How did you sit with the flatness?',
    'Did it stay that way all day, or shift at some point?',
  ],
  3: [
    'Did you actually let yourself enjoy it?',
    'What did you do with that energy?',
    'Did you celebrate it at all, or just keep moving?',
    'How did you make the most of it?',
    'Did you share it with anyone?',
  ],
  4: [
    'Did you let yourself fully have that day?',
    'How did you actually enjoy it — what did you do?',
    'Did you celebrate it, or just ride the wave?',
    'What did you do with all that energy?',
    'Did you mark the moment at all?',
  ],
};
function pickFollowUpQ(moodLevel) {
  const pool = FOLLOW_UP_POOLS[moodLevel] || FOLLOW_UP_POOLS[2];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildMirrorContext(mood, aliveData, note) {
  const noteSection = note
    ? `What they wrote (USE THIS — quote their exact words): "${note}"`
    : 'They did not add a note.';
  return `Today's mood: ${MOOD_LABELS[mood.moodLevel]} (${mood.moodLevel}/4)
${noteSection}

Alive Score today: Overall ${aliveData.aliveScore || 'N/A'} | Health ${aliveData.health || 'N/A'} | Wealth ${aliveData.wealth || 'N/A'} | Love ${aliveData.love || 'N/A'} | Purpose ${aliveData.purpose || 'N/A'}`;
}

// GET /api/mirror/today — today's latest entry + unanswered follow-up from yesterday
app.get('/api/mirror/today', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing device ID' });

    const today = req.headers['x-dev-date'] || new Date().toISOString().split('T')[0];
    const yesterdayD = new Date(today + 'T00:00:00Z');
    yesterdayD.setUTCDate(yesterdayD.getUTCDate() - 1);
    const yesterday = yesterdayD.toISOString().split('T')[0];

    // Query all device docs — filter by date in JS (avoids composite index requirement)
    const allSnap = await db.collection('mirrorCheckins')
      .where('deviceId', '==', deviceId)
      .get();
    const all = allSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const todayDocs = all
      .filter(c => c.date === today)
      .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));
    const latestToday = todayDocs[0] || null;

    const yestDocs = all
      .filter(c => c.date === yesterday)
      .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));
    const latestYest = yestDocs[0] || null;

    // Return unanswered follow-up from yesterday's most recent entry
    let followUp = null;
    if (latestYest?.followUpQ && !latestYest?.followUpA) {
      followUp = {
        q: latestYest.followUpQ,
        moodLevel: latestYest.moodLevel,
        mood: latestYest.mood,
        docId: latestYest.id,
      };
    }

    const todayTsMs = latestToday?.timestamp?.toMillis?.() || null;
    res.json({
      success: true,
      checkedIn: todayDocs.length > 0,
      today: latestToday ? {
        mood: latestToday.mood, moodLevel: latestToday.moodLevel,
        observation: latestToday.observation, note: latestToday.note,
        streak: latestToday.streak, id: latestToday.id,
        tsMs: todayTsMs,
      } : null,
      followUp,
    });
  } catch (err) {
    console.error('Mirror today error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch today' });
  }
});

// POST /api/mirror/checkin — save immediately, generate AI async
app.post('/api/mirror/checkin', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing device ID' });

    // followUpDocId + followUpAnswer: answer to yesterday's pending follow-up, submitted together
    const { moodLevel, note, aliveData, followUpDocId, followUpAnswer } = req.body;
    if (!moodLevel || moodLevel < 1 || moodLevel > 4) {
      return res.status(400).json({ success: false, error: 'Invalid moodLevel (1-4)' });
    }

    const today = req.headers['x-dev-date'] || new Date().toISOString().split('T')[0];
    const todayMs = new Date(today + 'T00:00:00Z').getTime();

    // Get history for streak + AI context
    const histSnap = await db.collection('mirrorCheckins')
      .where('deviceId', '==', deviceId)
      .get();
    const allDocs = histSnap.docs.map(d => ({ date: d.data().date, moodLevel: d.data().moodLevel }));

    // ── Block duplicate check-in ─────────────────────────────────────────────
    const todayDocs = histSnap.docs
      .filter(d => d.data().date === today)
      .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));
    if (todayDocs.length > 0) {
      const e = todayDocs[0].data();
      return res.status(409).json({
        success: false, alreadyCheckedIn: true,
        docId: todayDocs[0].id, mood: e.mood, moodLevel: e.moodLevel,
        note: e.note || null, observation: e.observation || null, streak: e.streak || 1,
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // Streak uses unique days only
    const uniquePastDates = [...new Set(allDocs.filter(d => d.date !== today).map(d => d.date))].sort().reverse();
    let streak = 1;
    for (let i = 0; i < uniquePastDates.length; i++) {
      const expected = new Date(todayMs - (i + 1) * 86400000).toISOString().split('T')[0];
      if (uniquePastDates[i] === expected) streak++;
      else break;
    }

    const followUpQ = pickFollowUpQ(moodLevel);
    const docRef = db.collection('mirrorCheckins').doc(); // auto-ID — unlimited entries per day

    // Save check-in + optionally save yesterday's follow-up answer in one shot
    const batch = db.batch();
    batch.set(docRef, {
      deviceId, date: today, docId: docRef.id,
      mood: MOOD_LABELS[moodLevel], moodLevel,
      note: note || null, observation: null, followUpQ,
      aliveScore: aliveData?.aliveScore || null,
      streak, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (followUpDocId && followUpAnswer) {
      const prevRef = db.collection('mirrorCheckins').doc(followUpDocId);
      batch.update(prevRef, { followUpA: followUpAnswer });
    }
    await batch.commit();

    // Respond immediately — client shows done state right away
    res.json({ success: true, observation: null, followUpQ, streak, mood: MOOD_LABELS[moodLevel], moodLevel, docId: docRef.id });

    // Generate AI observation in background
    try {
      const ctx = buildMirrorContext({ moodLevel }, aliveData || {}, note);
      const completion = await mirrorOpenAI.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 120,
        messages: [
          { role: 'system', content: MIRROR_SYSTEM_PROMPT },
          { role: 'user', content: ctx },
        ],
      });
      const observation = completion.choices[0]?.message?.content?.trim() || '';
      if (observation) await docRef.update({ observation });
    } catch (aiErr) {
      console.error('Mirror AI error:', aiErr.message);
      await docRef.update({ observation: 'Something real is happening. Keep showing up.' });
    }
  } catch (err) {
    console.error('Mirror checkin error:', err);
    res.status(500).json({ success: false, error: 'Failed to save check-in' });
  }
});

// POST /api/mirror/followup — save follow-up answer
app.post('/api/mirror/followup', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing device ID' });

    const { docId, answer } = req.body;
    if (!docId || !answer) return res.status(400).json({ success: false, error: 'Missing docId or answer' });

    await db.collection('mirrorCheckins').doc(docId).update({ followUpA: answer });
    res.json({ success: true });
  } catch (err) {
    console.error('Mirror followup error:', err);
    res.status(500).json({ success: false, error: 'Failed to save follow-up' });
  }
});

// POST /api/mirror/analysis — deep pattern analysis, gated: 7 unique check-ins since last
app.post('/api/mirror/analysis', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing device ID' });

    const { aliveData } = req.body;
    const THRESHOLD = 7;

    // 1. Get all check-ins, deduplicate by date (latest per day)
    const checkinSnap = await db.collection('mirrorCheckins').where('deviceId', '==', deviceId).get();
    const byDate = {};
    checkinSnap.docs.forEach(d => {
      const r = d.data();
      const tsMs = r.timestamp?.toMillis?.() || 0;
      if (!byDate[r.date] || tsMs > (byDate[r.date].tsMs || 0)) byDate[r.date] = { ...r, tsMs };
    });
    const uniqueCheckins = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    const totalUniqueDays = uniqueCheckins.length;

    // 2. Check if there's already an analysis and how many check-ins since
    const analysisSnap = await db.collection('mirrorAnalyses').where('deviceId', '==', deviceId).get();
    const analyses = analysisSnap.docs
      .map(d => ({ id: d.id, ...d.data(), generatedAtMs: d.data().generatedAt?.toMillis?.() || 0 }))
      .sort((a, b) => b.generatedAtMs - a.generatedAtMs);
    const latestAnalysis = analyses[0] || null;

    const checkinsSinceLast = Math.max(0, latestAnalysis ? totalUniqueDays - (latestAnalysis.checkinCount || 0) : totalUniqueDays);
    if (checkinsSinceLast < THRESHOLD) {
      return res.status(403).json({
        success: false, locked: true,
        needed: THRESHOLD - checkinsSinceLast,
        checkinsSinceLast, totalUniqueDays,
      });
    }

    if (totalUniqueDays === 0) {
      return res.status(403).json({ success: false, locked: true, needed: THRESHOLD, checkinsSinceLast: 0, totalUniqueDays: 0 });
    }

    // 3. Use last 30 unique-date check-ins for analysis
    const checkins = uniqueCheckins.slice(-30);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    checkins.forEach(c => { if (c.moodLevel) dist[c.moodLevel]++; });

    // Day-of-week mood averages
    const DAY_NAMES_A = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayStats = {};
    checkins.forEach(c => {
      const day = DAY_NAMES_A[new Date(c.date + 'T00:00:00').getDay()];
      if (!dayStats[day]) dayStats[day] = { total: 0, count: 0 };
      dayStats[day].total += c.moodLevel;
      dayStats[day].count++;
    });
    const dayBreakdown = Object.entries(dayStats)
      .sort((a, b) => DAY_NAMES_A.indexOf(a[0]) - DAY_NAMES_A.indexOf(b[0]))
      .map(([day, s]) => `${day}:${(s.total / s.count).toFixed(1)}`)
      .join(' | ');

    // Recent trend: last 5 vs previous 5
    const sorted = [...checkins].reverse();
    const last5avg = sorted.slice(0, 5).reduce((s, c) => s + c.moodLevel, 0) / Math.min(5, sorted.length);
    const prev5avg = sorted.slice(5, 10).length
      ? sorted.slice(5, 10).reduce((s, c) => s + c.moodLevel, 0) / sorted.slice(5, 10).length
      : null;
    const trendNote = prev5avg === null ? 'not enough data for trend'
      : last5avg > prev5avg + 0.3 ? `improving (last 5 avg ${last5avg.toFixed(1)} vs prev 5 avg ${prev5avg.toFixed(1)})`
      : last5avg < prev5avg - 0.3 ? `declining (last 5 avg ${last5avg.toFixed(1)} vs prev 5 avg ${prev5avg.toFixed(1)})`
      : `stable (last 5 avg ${last5avg.toFixed(1)})`;

    const history = checkins.map(c => {
      const parts = [`${c.date} | ${MOOD_LABELS[c.moodLevel] || '?'}`];
      if (c.note) parts.push(`note: "${c.note}"`);
      if (c.followUpA) parts.push(`follow-up: "${c.followUpA}"`);
      return parts.join(' | ');
    }).join('\n');

    const userPrompt = `Read this person's full check-in history and return EXACTLY this format — 6 labeled lines, nothing else:

PATTERN: [one sentence — dominant mood, what kept showing up, include rough/good/okay counts]
QUOTE: "[copy their EXACT words from a note]" — [what it reveals about them, max 8 words]
HIDDEN: [one sentence — something about timing, day of week, or triggers they definitely haven't noticed themselves — be specific, use the day breakdown data]
TRUTH: [one sentence — the most uncomfortable specific truth this data shows — not generic, not soft]
CONCLUSION: [one sentence using "we" — honest verdict: are we doing well or do we need to work on something specific. e.g. "We need to deal with whatever's happening at work every week." or "We're in a good stretch — let's not sleepwalk through it."]
GOALS: [goal 1] | [goal 2] | [goal 3] | [goal 4] | [goal 5]

Rules:
- PATTERN: state counts, e.g. "8 rough days out of 13 — mostly in the first half."
- QUOTE: copy word-for-word from their notes. Put in quotes. Do not paraphrase.
- HIDDEN: must use the day-of-week data or timing data to name a specific pattern. e.g. "Mondays average 1.5 — worst day by far." If no clear day pattern, look for trigger patterns in notes.
- TRUTH: must be specific to their data. Not "you're stressed" — say WHY and WHAT. Make it land.
- CONCLUSION: "we" always. Name the actual thing to work on or celebrate. No vague language.
- GOALS: always include. Write exactly 3-5 goals separated by " | ". Goals must be specific, concrete, and directly derived from their check-in patterns and notes — not generic. Each goal is one short actionable sentence. e.g. "Text one person when work feels heavy" or "Block 20 mins after work before checking your phone" or "Name what made the good days good and repeat it". Tailor to what their data actually shows.
- If data is genuinely unclear for a section, say so briefly — do not invent.
- No padding, no intro, no bullet points, no emojis. Six labeled lines only.

Stats:
Total: ${checkins.length} check-ins | Rough ${dist[1]}× · Okay ${dist[2]}× · Good ${dist[3]}× · Thriving ${dist[4]}×
Trend: ${trendNote}
Day averages (1=Rough 4=Thriving): ${dayBreakdown}
Alive Score: ${aliveData?.aliveScore || 'N/A'} | Health: ${aliveData?.pillarScores?.health || 'N/A'} | Wealth: ${aliveData?.pillarScores?.wealth || 'N/A'} | Love: ${aliveData?.pillarScores?.love || 'N/A'} | Purpose: ${aliveData?.pillarScores?.purpose || 'N/A'}

Check-ins (oldest → newest):
${history}`;

    const completion = await mirrorOpenAI.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 480,
      messages: [
        { role: 'system', content: 'You are Mirror — the one friend who has read every single check-in and tells the truth. Return exactly 6 labeled lines: PATTERN:, QUOTE:, HIDDEN:, TRUTH:, CONCLUSION:, GOALS:. No bullets. No intro. No extra text. Each line starts with its label. GOALS: is always the last line — write 3-5 short goals separated by " | ", specific to their data. Be specific throughout — reference actual counts, days, words they wrote. The goal: make them say "how did it know that?" Sound like a person paying close attention, not an AI.' },
        { role: 'user', content: userPrompt },
      ],
    });

    const analysis = completion.choices[0]?.message?.content?.trim() || 'Mirror sees something forming. Check back as more data arrives.';

    // 4. Persist analysis so user can view it anytime
    await db.collection('mirrorAnalyses').add({
      deviceId, analysis,
      checkinCount: totalUniqueDays,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, analysis, checkinCount: totalUniqueDays });
  } catch (err) {
    console.error('Mirror analysis error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate analysis' });
  }
});

// GET /api/mirror/analysis/status — latest saved analysis + progress toward next
app.get('/api/mirror/analysis/status', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false });

    const THRESHOLD = 7;

    // Unique check-in days
    const checkinSnap = await db.collection('mirrorCheckins').where('deviceId', '==', deviceId).get();
    const uniqueDates = new Set(checkinSnap.docs.map(d => d.data().date));
    const totalUniqueDays = uniqueDates.size;

    // Latest saved analysis
    const analysisSnap = await db.collection('mirrorAnalyses').where('deviceId', '==', deviceId).get();
    const analyses = analysisSnap.docs
      .map(d => ({ id: d.id, ...d.data(), generatedAtMs: d.data().generatedAt?.toMillis?.() || 0 }))
      .sort((a, b) => b.generatedAtMs - a.generatedAtMs);
    const latest = analyses[0] || null;

    const checkinsSinceLast = Math.max(0, latest ? totalUniqueDays - (latest.checkinCount || 0) : totalUniqueDays);
    const needed = Math.max(0, THRESHOLD - checkinsSinceLast);
    const canGenerate = needed === 0;

    res.json({
      success: true,
      latest: latest ? {
        analysis: latest.analysis,
        generatedAtMs: latest.generatedAtMs,
        checkinCount: latest.checkinCount,
      } : null,
      totalUniqueDays,
      checkinsSinceLast,
      needed,
      canGenerate,
    });
  } catch (e) {
    console.error('[Mirror] analysis status error:', e);
    res.status(500).json({ success: false });
  }
});

// ── Goals CRUD ──────────────────────────────────────────────────────────────

// GET /api/mirror/goals
app.get('/api/mirror/goals', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false });
    const snap = await db.collection('mirrorGoals')
      .where('deviceId', '==', deviceId)
      .get();
    const goals = snap.docs
      .map(d => {
        const data = d.data();
        return { id: d.id, text: data.text, source: data.source,
          createdAt: data.createdAt?.toMillis?.() || 0 };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, goals });
  } catch (e) {
    console.error('[Goals] fetchGoals error:', e);
    res.status(500).json({ success: false });
  }
});

// POST /api/mirror/goals
app.post('/api/mirror/goals', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    const { text, source = 'custom' } = req.body;
    if (!deviceId || !text?.trim()) return res.status(400).json({ success: false });
    const ref = db.collection('mirrorGoals').doc();
    await ref.set({ deviceId, text: text.trim(), source, completed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, id: ref.id, text: text.trim(), source, completed: false });
  } catch (e) { res.status(500).json({ success: false }); }
});

// PATCH /api/mirror/goals/:id — toggle complete
app.patch('/api/mirror/goals/:id', async (req, res) => {
  try {
    const { completed } = req.body;
    const update = completed
      ? { completed: true, completedAt: admin.firestore.FieldValue.serverTimestamp() }
      : { completed: false };
    await db.collection('mirrorGoals').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

// DELETE /api/mirror/goals/:id
app.delete('/api/mirror/goals/:id', async (req, res) => {
  try {
    await db.collection('mirrorGoals').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

// GET /api/mirror/history — all check-ins for 365-dot grid
app.get('/api/mirror/history', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing device ID' });

    const snap = await db.collection('mirrorCheckins')
      .where('deviceId', '==', deviceId)
      .get();

    // Deduplicate by date — keep latest entry per day (GitHub contribution-graph style)
    const byDate = {};
    snap.docs.forEach(d => {
      const r = d.data();
      const tsMs = r.timestamp?.toMillis?.() || 0;
      if (!byDate[r.date] || tsMs > (byDate[r.date].tsMs || 0)) {
        byDate[r.date] = {
          id: d.id, date: r.date, moodLevel: r.moodLevel, mood: r.mood,
          note: r.note || null, observation: r.observation || null,
          followUpQ: r.followUpQ || null, followUpA: r.followUpA || null,
          streak: r.streak || null, tsMs,
        };
      }
    });
    const checkins = Object.values(byDate).sort((a, b) => a.tsMs - b.tsMs || a.date.localeCompare(b.date));

    res.json({ success: true, checkins });
  } catch (err) {
    console.error('Mirror history error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

// DELETE /api/mirror/today — DEV ONLY: reset today's check-in for testing
app.delete('/api/mirror/today', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ success: false });
    const today = new Date().toISOString().split('T')[0];
    const snap = await db.collection('mirrorCheckins').where('deviceId', '==', deviceId).get();
    const batch = db.batch();
    snap.docs.filter(d => d.data().date === today).forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
  console.log(`🚀 ALIVE SCORE SERVER - PRODUCTION MODE`);
  console.log(`${'='.repeat(60)}\n`);
  console.log(`📡 Server:          http://localhost:${PORT}`);
  console.log(`📝 Environment:     ${process.env.NODE_ENV || 'production'}`);
  console.log(`🔐 Auth:            ✅ Device ID only`);
  console.log(`🏆 Alive Score:     ✅ Managed in /api/alive-check`);
  console.log(`🔑 Unified Code:    ✅ Auto-generated on first use`);
  console.log(`🤖 AI Scoring:      ✅ GPT-4o-mini per pillar`);
  console.log(`📊 Analytics:       ✅ Pillar trends & history`);
  console.log(`⚡ Performance:     ✅ OPTIMIZED`);
  console.log(`\n${'='.repeat(60)}`);
});

module.exports = app;