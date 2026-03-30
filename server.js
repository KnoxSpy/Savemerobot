const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

// --- Global Error Handling ---
process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 7767338426;

// --- Firebase Initialization with Safety Check ---
try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT Environment Variable is missing!");
    }
    
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
    console.log("Firebase Initialized Successfully");
} catch (error) {
    console.error("Firebase Init Error:", error.message);
    // যদি ফায়ারবেস ঠিক না হয়, সার্ভার বন্ধ না করে লগ দিবে যাতে আপনি বুঝতে পারেন সমস্যা কোথায়
}

const db = admin.database();

// Bot Initialization
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userSessions = {}; 

const chatBoxConfig = {
    reply_markup: {
        keyboard: [[{ text: "🤖 SavedMe Robot" }]],
        resize_keyboard: true,
        input_field_placeholder: "Send me links"
    }
};

// Health Check route for Render
app.get('/', (req, res) => {
    res.send('Bot is running...');
});

// --- Admin Panel API Routes ---
app.get('/api/admin/data', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const adminSnap = await db.ref('admin_settings').once('value');
        const statsSnap = await db.ref(`daily_stats/${today}`).once('value');
        const settings = adminSnap.val() || {};
        settings.dailyUsers = statsSnap.numChildren() || 0;
        res.json(settings);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/settings', async (req, res) => {
    const { text, img } = req.body;
    await db.ref('admin_settings').update({ welcomeText: text, welcomeImage: img });
    res.json({ success: true });
});

app.post('/api/admin/add-channel', async (req, res) => {
    const { name, user } = req.body;
    const snap = await db.ref('admin_settings/channels').once('value');
    let channels = snap.val() || [];
    channels.push({ name, user });
    await db.ref('admin_settings/channels').set(channels);
    res.json({ success: true });
});

app.post('/api/admin/del-channel', async (req, res) => {
    const { index } = req.body;
    const snap = await db.ref('admin_settings/channels').once('value');
    let channels = snap.val() || [];
    channels.splice(index, 1);
    await db.ref('admin_settings/channels').set(channels);
    res.json({ success: true });
});

app.post('/api/admin/broadcast', async (req, res) => {
    const { img, text, btnText, btnUrl } = req.body;
    const userSnap = await db.ref('all_users').once('value');
    const users = userSnap.val() || {};
    const userIds = Object.keys(users);
    
    let count = 0;
    const opts = { parse_mode: 'Markdown' };
    if (btnText && btnUrl) {
        opts.reply_markup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
    }

    for (const id of userIds) {
        try {
            if (img && img.trim() !== "") {
                await bot.sendPhoto(id, img, { caption: text, ...opts });
            } else {
                await bot.sendMessage(id, text, opts);
            }
            count++;
        } catch (e) {}
    }
    res.json({ count });
});

// --- Bot Logic ---
async function trackUser(chatId) {
    const today = new Date().toISOString().split('T')[0];
    await db.ref(`all_users/${chatId}`).set(true);
    await db.ref(`daily_stats/${today}/${chatId}`).set(true);
}

async function getMissingChannels(userId) {
    const snap = await db.ref('admin_settings/channels').once('value');
    const allChannels = snap.val() || [];
    if (allChannels.length === 0) return [];

    let missing = [];
    for (const ch of allChannels) {
        try {
            let username = ch.user.includes('t.me/') ? `@${ch.user.split('/').pop()}` : ch.user;
            const res = await bot.getChatMember(username, userId);
            if (['left', 'kicked'].includes(res.status)) {
                missing.push(ch);
            }
        } catch (e) {
            missing.push(ch);
        }
    }
    return missing;
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    await trackUser(chatId).catch(e => console.error("Track User Error:", e));

    if (text === '/start') {
        try {
            const snap = await db.ref('admin_settings').once('value');
            const data = snap.val() || {};
            const welcomeMsg = data.welcomeText || "Welcome!";
            const welcomeImg = data.welcomeImage || "https://telegra.ph/file/default.jpg";

            const opts = {
                caption: welcomeMsg,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "📢 Join Channel", url: "https://t.me/+GyFgfeJIub81MDg9" },
                            { text: "👥 Join Group", url: "https://t.me/+V8XTiO_Vo8tlOGZl" }
                        ],
                        [{ text: "➕ Add Bot to Group", url: `https://t.me/${(await bot.getMe()).username}?startgroup=true` }]
                    ],
                    keyboard: [[{ text: "🤖 SavedMe Robot" }]],
                    resize_keyboard: true,
                    input_field_placeholder: "Send me links"
                }
            };
            return bot.sendPhoto(chatId, welcomeImg, opts);
        } catch (e) { console.error("Start Error:", e); }
    }

    if (text.startsWith('http')) {
        const missingChannels = await getMissingChannels(chatId);
        
        if (missingChannels.length > 0) {
            userSessions[chatId] = text;
            const buttons = missingChannels.map(c => [{ 
                text: `📢 ${c.name}`, 
                url: c.user.startsWith('http') ? c.user : `https://t.me/${c.user.replace('@','')}` 
            }]);
            buttons.push([{ text: "✅ Verify", callback_data: "verify_join" }]);

            return bot.sendMessage(chatId, "⚠️ **You must join our channels to use this bot!**", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
        processDownload(chatId, text);
    }
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    if (q.data === "verify_join") {
        const missingChannels = await getMissingChannels(chatId);
        if (missingChannels.length === 0) {
            await bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
            const link = userSessions[chatId];
            if (link) processDownload(chatId, link);
        } else {
            bot.answerCallbackQuery(q.id, { text: "❌ You haven't joined all channels yet!", show_alert: true });
        }
    }
});

async function processDownload(chatId, url) {
    const waitMsg = await bot.sendMessage(chatId, "⏳ Processing your link...", chatBoxConfig);
    try {
        const res = await axios.get(`https://r-gengpt-api.vercel.app/api/video/download?url=${encodeURIComponent(url)}`);
        const data = res.data.data;
        if (data && data.medias) {
            const video = data.medias.find(m => m.type === 'video') || data.medias[0];
            const customCaption = `${data.title || ''}\n\nDownloaded by : @SavedMe_Robot`;
            await bot.sendVideo(chatId, video.url, { caption: customCaption });
            await bot.deleteMessage(chatId, waitMsg.message_id);
        } else {
            bot.editMessageText("❌ Video not found or link not supported.", { chat_id: chatId, message_id: waitMsg.message_id });
        }
    } catch (e) {
        bot.editMessageText("❌ Error: Unable to fetch video.", { chat_id: chatId, message_id: waitMsg.message_id });
    }
}

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'indexadmin.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
