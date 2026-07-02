const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

// --- Global Error Handling ---
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception occurred:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

// --- Firebase Initialization ---
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DB_URL
        });
        console.log("Firebase initialized successfully.");
    } else {
        console.warn("Firebase credentials missing in environment variables.");
    }
} catch (error) {
    console.error("Firebase Init Error:", error.message);
}

const db = admin.database();
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userSessions = {}; 
const audioCache = {}; 

const chatBoxConfig = {
    reply_markup: {
        keyboard: [[{ text: "🤖 SnapSavingBot" }]],
        resize_keyboard: true,
        input_field_placeholder: "Send me links"
    }
};

// --- Page Routes ---
app.get('/', (req, res) => { res.send('Bot is running...'); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'indexadmin.html')); });
app.get('/reels', (req, res) => { res.sendFile(path.join(__dirname, 'reels.html')); });

// --- Admin Panel API Routes ---
app.get('/api/admin/data', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM Format

        const adminSnap = await db.ref('admin_settings').once('value');
        const dailySnap = await db.ref(`daily_stats/${today}`).once('value');
        const monthlySnap = await db.ref(`monthly_stats/${currentMonth}`).once('value');
        const totalUsersSnap = await db.ref('all_users').once('value');
        const downloadsSnap = await db.ref('stats/total_downloads').once('value');

        const settings = adminSnap.val() || {};
        
        settings.dailyUsers = dailySnap.numChildren() || 0;
        settings.monthlyUsers = monthlySnap.numChildren() || 0;
        settings.totalUsers = totalUsersSnap.numChildren() || 0;
        settings.totalDownloads = downloadsSnap.val() || 0;

        if (!settings.channels) settings.channels = [];
        if (!settings.ads) settings.ads = [];

        res.json(settings);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/settings', async (req, res) => {
    try {
        const { text, img } = req.body;
        await db.ref('admin_settings').update({ welcomeText: text, welcomeImage: img });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/add-channel', async (req, res) => {
    try {
        const { name, user } = req.body;
        const snap = await db.ref('admin_settings/channels').once('value');
        let channels = snap.val() || [];
        channels.push({ name, user });
        await db.ref('admin_settings/channels').set(channels);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/del-channel', async (req, res) => {
    try {
        const { index } = req.body;
        const snap = await db.ref('admin_settings/channels').once('value');
        let channels = snap.val() || [];
        channels.splice(index, 1);
        await db.ref('admin_settings/channels').set(channels);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Ad Management API Routes ---
app.post('/api/admin/save-ad', async (req, res) => {
    try {
        const { index, text, link } = req.body;
        const snap = await db.ref('admin_settings/ads').once('value');
        let ads = snap.val() || [];

        if (index !== undefined && index >= 0 && index < ads.length) {
            ads[index] = { text, link }; 
        } else {
            ads.push({ text, link }); 
        }

        await db.ref('admin_settings/ads').set(ads);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/del-ad', async (req, res) => {
    try {
        const { index } = req.body;
        const snap = await db.ref('admin_settings/ads').once('value');
        let ads = snap.val() || [];

        if (index !== undefined && index >= 0 && index < ads.length) {
            ads.splice(index, 1);
            await db.ref('admin_settings/ads').set(ads);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Broadcast API Route ---
app.post('/api/admin/broadcast', async (req, res) => {
    const { type, photoUrl, message, buttonsText } = req.body;
    
    try {
        const inline_keyboard = [];
        if (buttonsText && buttonsText.trim()) {
            const lines = buttonsText.split('\n');
            lines.forEach(line => {
                const parts = line.split('|');
                if (parts.length === 2) {
                    inline_keyboard.push([{
                        text: parts[0].trim(),
                        url: parts[1].trim()
                    }]);
                }
            });
        }

        const options = {
            parse_mode: 'HTML',
            reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
        };

        const usersSnap = await db.ref('all_users').once('value');
        const users = usersSnap.val() ? Object.keys(usersSnap.val()) : [];

        let successCount = 0;
        let failCount = 0;

        for (const userId of users) {
            try {
                if (type === 'photo' && photoUrl) {
                    await bot.sendPhoto(userId, photoUrl, { ...options, caption: message });
                } else {
                    await bot.sendMessage(userId, message, options);
                }
                successCount++;
            } catch (e) {
                failCount++;
            }
            await new Promise(resolve => setTimeout(resolve, 40)); 
        }

        res.json({ success: true, successCount, failCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Mini App Support Routes ---
app.get('/api/videos', async (req, res) => {
    try {
        const snap = await db.ref('mini_app_videos').orderByChild('timestamp').once('value');
        const data = snap.val() || {};
        
        const videoList = Object.keys(data).map(key => ({
            id: key,
            ...data[key]
        })).reverse();
        
        res.json(videoList);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/video/stream/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        response.data.pipe(res);
    } catch (err) {
        console.error("Streaming error:", err.message);
        res.status(500).send("Error streaming video.");
    }
});

app.post('/api/video/like', async (req, res) => {
    const { videoId, isLiked } = req.body;
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    try {
        const likeRef = db.ref(`mini_app_videos/${videoId}/likes`);
        await likeRef.transaction((currentLikes) => {
            if (isLiked) {
                return (currentLikes || 0) + 1;
            } else {
                return Math.max(0, (currentLikes || 1) - 1);
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Bot Logic ---
async function trackUser(chatId) {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    
    await db.ref(`all_users/${chatId}`).set(true);
    await db.ref(`daily_stats/${today}/${chatId}`).set(true);
    await db.ref(`monthly_stats/${currentMonth}/${chatId}`).set(true);
}

async function getMissingChannels(userId) {
    try {
        const snap = await db.ref('admin_settings/channels').once('value');
        const allChannels = snap.val() || [];
        if (allChannels.length === 0) return [];
        let missing = [];
        for (const ch of allChannels) {
            try {
                let username = ch.user.includes('t.me/') ? `@${ch.user.split('/').pop()}` : ch.user;
                const res = await bot.getChatMember(username, userId);
                if (['left', 'kicked', 'restricted'].includes(res.status)) missing.push(ch);
            } catch (e) { missing.push(ch); }
        }
        return missing;
    } catch (e) { return []; }
}

// চ্যানেলে নতুন ভিডিও পোস্ট হওয়ার সাথে সাথে ডাটাবেসে সিঙ্ক
bot.on('channel_post', async (msg) => {
    if (msg.video) {
        try {
            const video = msg.video;
            const fileId = video.file_id;
            const caption = msg.caption || "";
            const messageId = msg.message_id;

            await db.ref(`mini_app_videos/${messageId}`).set({
                fileId: fileId,
                caption: caption,
                likes: 0,
                views: 0,
                timestamp: admin.database.ServerValue.TIMESTAMP
            });
            console.log(`Video Synced: ${messageId}`);
        } catch (err) {
            console.error("Video sync error:", err.message);
        }
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    await trackUser(chatId).catch(() => {});

    if (text === '/start' || text === '🤖 SnapSavingBot') {
        try {
            const snap = await db.ref('admin_settings').once('value');
            const data = snap.val() || {};
            const welcomeMsg = data.welcomeText || "Welcome!";
            const welcomeImg = data.welcomeImage || "https://telegra.ph/file/default.jpg";

            return bot.sendPhoto(chatId, welcomeImg, {
                caption: welcomeMsg,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "📢 Join Channel", url: "https://t.me/+GyFgfeJIub81MDg9" },
                            { text: "👥 Join Group", url: "https://t.me/+V8XTiO_Vo8tlOGZl" }
                        ],
                        [{ text: "➕ Add Bot to Group", url: `https://t.me/${(await bot.getMe()).username}?startgroup=true` }]
                    ],
                    keyboard: [[{ text: "🤖 SnapSavingBot" }]],
                    resize_keyboard: true
                }
            });
        } catch (e) { console.error(e); }
    }

    if (text.startsWith('http')) {
        const missingChannels = await getMissingChannels(chatId);
        if (missingChannels.length > 0) {
            userSessions[chatId] = text;
            
            const buttons = [];
            for (let i = 0; i < missingChannels.length; i += 2) {
                const row = missingChannels.slice(i, i + 2).map(c => ({
                    text: `📢 ${c.name}`,
                    url: c.user.startsWith('http') ? c.user : `https://t.me/${c.user.replace('@','')}`
                }));
                buttons.push(row);
            }
            buttons.push([{ text: "✅ Verify", callback_data: "verify_join" }]);

            return bot.sendMessage(chatId, "⚠️ **You must join our channels to use this bot!**", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
        processDownload(chatId, text, msg.message_id);
    }
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    if (q.data === "verify_join") {
        const missingChannels = await getMissingChannels(chatId);
        if (missingChannels.length === 0) {
            await bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
            const link = userSessions[chatId];
            if (link) processDownload(chatId, link, null);
        } else {
            bot.answerCallbackQuery(q.id, { text: "❌ You haven't joined all channels yet!", show_alert: true });
        }
    }
    if (q.data === "send_audio") {
        const audioUrl = audioCache[chatId];
        if (audioUrl) {
            bot.answerCallbackQuery(q.id, { text: "Sending Audio..." });
            bot.sendAudio(chatId, audioUrl, { caption: "Use This - @SnapSavingBot" });
        }
    }
});

function getProgressBar(percent) {
    const totalBars = 10;
    const filledBars = Math.round((percent / 100) * totalBars);
    const emptyBars = totalBars - filledBars;
    return "■".repeat(filledBars) + "□".repeat(emptyBars);
}

async function processDownload(chatId, url, msgId) {
    if (msgId) {
        try {
            await bot._request('setMessageReaction', {
                chat_id: chatId,
                message_id: msgId,
                reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
            });
        } catch (e) {}
    }

    const loadingMsg = await bot.sendMessage(chatId, "⏳", chatBoxConfig);
    
    let progress = 0;
    let isDownloaded = false;

    const interval = setInterval(async () => {
        if (progress < 95 && !isDownloaded) {
            progress += Math.floor(Math.random() * 10) + 5;
            if (progress > 95) progress = 95;
            const bar = getProgressBar(progress);
            await bot.editMessageText(`⏳ Loading... [${bar}] ${progress}%`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            }).catch(() => {});
        }
    }, 800);

    try {
        const res = await axios.get(`https://r-gengpt-api.vercel.app/api/video/download?url=${encodeURIComponent(url)}`);
        const data = res.data.data;
        isDownloaded = true;
        clearInterval(interval);

        if (data && data.medias) {
            await bot.editMessageText(`🪄 Success [${getProgressBar(100)}] 100%`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            }).catch(() => {});

            // মোট ডাউনলোড সংখ্যা বৃদ্ধি
            await db.ref('stats/total_downloads').transaction((current) => (current || 0) + 1);

            const video = data.medias.find(m => m.type === 'video') || data.medias[0];
            const audio = data.medias.find(m => m.type === 'audio');
            if (audio) audioCache[chatId] = audio.url;

            // ডায়নামিক অ্যাড রোটেশন প্রসেস
            let adTextCaption = "";
            try {
                const adminSnap = await db.ref('admin_settings').once('value');
                const settings = adminSnap.val() || {};
                const ads = settings.ads || [];
                if (ads.length > 0) {
                    const randomAd = ads[Math.floor(Math.random() * ads.length)];
                    adTextCaption = `\n\nAd → <a href="${randomAd.link}"><b>${randomAd.text}</b></a>`;
                }
            } catch (adErr) {
                console.error("Ad append error:", adErr);
            }

            // শেয়ার বাটন ইনফরমেশন
            const botInfo = await bot.getMe();
            const botUsername = botInfo.username;
            const shareText = encodeURIComponent(`SaveMe Bot ব্যবহার করে যেকোনো সোশ্যাল মিডিয়া ভিডিও সহজে ডাউনলোড করুন! 📥`);
            const shareUrl = `https://t.me/share/url?url=https://t.me/${botUsername}&text=${shareText}`;

            const inlineKeyboardButtons = [];
            const actionRow = [];

            if (audio) {
                actionRow.push({ text: "Audio 🎵", callback_data: "send_audio" });
            }
            actionRow.push({ text: "Share to Friends 💕", url: shareUrl });
            inlineKeyboardButtons.push(actionRow);

            const videoOpts = { 
                caption: `Use This - @SnapSavingBot` + adTextCaption,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: inlineKeyboardButtons
                }
            };

            await bot.sendVideo(chatId, video.url, videoOpts);
            
            setTimeout(() => {
                bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            }, 1000);
        } else {
            bot.editMessageText("❌ Video not found.", { chat_id: chatId, message_id: loadingMsg.message_id });
        }
    } catch (e) {
        isDownloaded = true;
        clearInterval(interval);
        bot.editMessageText("❌ Error: Unable to fetch video.", { chat_id: chatId, message_id: loadingMsg.message_id });
    }
}

app.listen(PORT, () => { console.log(`Server started on port ${PORT}`); });
