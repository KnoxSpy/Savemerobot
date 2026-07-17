const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

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
const TARGET_CHANNEL = 'reelsuploder'; 
const ADMIN_ID = '7304915019'; 

const DOMAIN_NAME = process.env.DOMAIN_NAME || 'snapsaving-reels.vercel.app';

const strings = {
    en: {
        welcome: "Welcome to SnapSaving! Send me any social media video link to download.",
        must_join: "⚠️ You must join our channels to use this bot!",
        verify: "✅ Verify Join",
        not_joined: "❌ You haven't joined all channels yet!",
        sending_audio: "Sending Audio...",
        video_not_found: "❌ Video not found.",
        error_fetch: "❌ Something went wrong or the video could not be found. Please try another video link.",
        join_ch: "📢 Join Channel",
        join_gr: "👥 Join Group",
        add_gr: "➕ Add Bot to Group",
        lang_btn: "🇧🇩 Change to বাংলা",
        lang_switched: "Language changed to English.",
        settings_title: "⚙️ <b>Your Preferences & Settings</b>\n\nConfigure your Mini-App settings directly from here:",
        notify_on: "Notifications: ON 🔔",
        notify_off: "Notifications: OFF 🔕",
        upload_on: "Reels Upload: ON 📤",
        upload_off: "Reels Upload: OFF 📥",
        change_lang: "Language: English 🌐",
        watch_btn: "Watch Video"
    },
    bn: {
        welcome: "SnapSaving-এ স্বাগতম! ভিডিও ডাউনলোড করতে যেকোনো লিংক পাঠান।",
        must_join: "⚠️ আমাদের চ্যানেলে জয়েন করতে হবে এই বটটি ব্যবহার করতে!",
        verify: "✅ ভেরিফাই করুন",
        not_joined: "❌ আপনি এখনো সব চ্যানেলে জয়েন করেননি!",
        sending_audio: "অডিও পাঠানো হচ্ছে...",
        video_not_found: "❌ ভিডিও পাওয়া যায়নি।",
        error_fetch: "❌ কোন একটি সমস্যা হচ্ছে অথবা ভিডিও টি খুজে পাওয়া যায়নি অন্য ভিডিও লিংক দিন।",
        join_ch: "📢 চ্যানেলে জয়েন করুন",
        join_gr: "👥 গ্রুপে জয়েন করুন",
        add_gr: "➕ গ্রুপে বট যুক্ত করুন",
        lang_btn: "🇬🇧 Change to English",
        lang_switched: "ভাষা পরিবর্তন করে বাংলা করা হয়েছে।",
        settings_title: "⚙️ <b>আপনার সেটিংস ও পছন্দসমূহ</b>\n\nনিচের বাটনগুলো দিয়ে আপনার মিনি অ্যাপের সেটিংস পরিবর্তন করুন:",
        notify_on: "নোটিফিকেশন: চালু 🔔",
        notify_off: "নোটিফিকেশন: বন্ধ 🔕",
        upload_on: "রিল আপলোড: চালু 📤",
        upload_off: "রিল আপলোড: বন্ধ 📥",
        change_lang: "ভাষা: বাংলা 🌐",
        watch_btn: "Watch Video"
    }
};

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DB_URL
        });
        console.log("Firebase initialized successfully.");
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
        keyboard: [[{ text: "🇧🇩 বাংলা / 🇬🇧 English" }]],
        resize_keyboard: true,
        input_field_placeholder: "Send links to download"
    }
};

async function getUserProfileInfo(userId) {
    try {
        const chat = await bot.getChat(userId);
        const name = chat.first_name ? `${chat.first_name} ${chat.last_name || ''}`.trim() : (chat.title || chat.username || "Anonymous");
        
        let photoUrl = "https://via.placeholder.com/150";
        if (chat.photo && chat.photo.small_file_id) {
            const file = await bot.getFile(chat.photo.small_file_id);
            photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        }
        return { name, photoUrl };
    } catch (err) {
        return { name: "Anonymous", photoUrl: "https://via.placeholder.com/150" };
    }
}

async function sendNotification(uploaderId, message) {
    if (!uploaderId || uploaderId.startsWith('-100')) return;
    try {
        const settingsSnap = await db.ref(`users/${uploaderId}/settings`).once('value');
        const settings = settingsSnap.val() || {};
        const notificationsEnabled = settings.notifications !== false;

        if (notificationsEnabled) {
            await bot.sendMessage(uploaderId, message, { parse_mode: 'HTML' });
        }
    } catch (err) {
        console.error("Failed to send notification:", err.message);
    }
}

async function getSettingsKeyboard(chatId) {
    const lang = await getUserLang(chatId);
    const str = strings[lang];

    const settingsSnap = await db.ref(`users/${chatId}/settings`).once('value');
    const settings = settingsSnap.val() || { uploadingReels: true, notifications: true };

    const notifyBtnText = settings.notifications !== false ? str.notify_on : str.notify_off;
    const uploadBtnText = settings.uploadingReels !== false ? str.upload_on : str.upload_off;

    return {
        inline_keyboard: [
            [{ text: str.change_lang, callback_data: lang === 'en' ? 'setlang_bn' : 'setlang_en' }],
            [
                { text: notifyBtnText, callback_data: 'toggle_notify' },
                { text: uploadBtnText, callback_data: 'toggle_upload' }
            ]
        ]
    };
}

app.get('/', (req, res) => { res.send('Bot is running...'); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'indexadmin.html')); });
app.get('/reels', (req, res) => { res.sendFile(path.join(__dirname, 'reels.html')); });

app.get('/api/admin/data', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = new Date().toISOString().slice(0, 7);

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

app.get('/api/user/lang', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    try {
        const lang = await getUserLang(userId);
        res.json({ lang });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/videos', async (req, res) => {
    try {
        const { seenVideos } = req.body;
        const snap = await db.ref('mini_app_videos').once('value');
        const data = snap.val() || {};

        const adminSnap = await db.ref('admin_settings').once('value');
        const settings = adminSnap.val() || {};
        const ads = settings.ads || [];
        
        let videoList = Object.keys(data).map(key => {
            let video = { id: key, ...data[key] };

            if (ads.length > 0) {
                const randomAd = ads[Math.floor(Math.random() * ads.length)];
                video.caption = `<a href="${randomAd.link}" target="_blank" class="caption-link"><b>${randomAd.text}</b></a>`;
            } else {
                video.caption = `<a href="https://t.me/SnapSavingBot" target="_blank" class="caption-link"><b>Visit @SnapSavingBot for more videos!</b></a>`;
            }

            const sizeMB = video.fileSize ? `${(video.fileSize / (1024 * 1024)).toFixed(2)} MB` : "Unknown Size";
            const uploadDate = video.timestamp ? new Date(video.timestamp).toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' }) : "Unknown Date";
            
            video.formattedSize = sizeMB;
            video.formattedDate = uploadDate;

            return video;
        });

        let wasReset = false;
        const seenSet = new Set(seenVideos || []);
        let filteredList = videoList.filter(video => !seenSet.has(video.id));

        if (filteredList.length === 0 && videoList.length > 0) {
            filteredList = videoList;
            wasReset = true;
        }

        res.json({
            videos: filteredList,
            wasReset
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/videos', async (req, res) => {
    try {
        const snap = await db.ref('mini_app_videos').once('value');
        const data = snap.val() || {};

        const adminSnap = await db.ref('admin_settings').once('value');
        const settings = adminSnap.val() || {};
        const ads = settings.ads || [];
        
        let videoList = Object.keys(data).map(key => {
            let video = { id: key, ...data[key] };

            if (ads.length > 0) {
                const randomAd = ads[Math.floor(Math.random() * ads.length)];
                video.caption = `<a href="${randomAd.link}" target="_blank" class="caption-link"><b>${randomAd.text}</b></a>`;
            } else {
                video.caption = `<a href="https://t.me/SnapSavingBot" target="_blank" class="caption-link"><b>Visit @SnapSavingBot for more videos!</b></a>`;
            }

            const sizeMB = video.fileSize ? `${(video.fileSize / (1024 * 1024)).toFixed(2)} MB` : "Unknown Size";
            const uploadDate = video.timestamp ? new Date(video.timestamp).toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' }) : "Unknown Date";
            
            video.formattedSize = sizeMB;
            video.formattedDate = uploadDate;

            return video;
        });
        
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

        const headers = {};
        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream',
            headers: headers
        });

        res.writeHead(response.status, response.headers);
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send("Error streaming video.");
    }
});

app.post('/api/video/like', async (req, res) => {
    const { videoId, isLiked, userId, username } = req.body;
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    try {
        const videoRef = db.ref(`mini_app_videos/${videoId}`);
        const videoSnap = await videoRef.once('value');
        const video = videoSnap.val();

        if (!video) return res.status(404).json({ error: "Video not found" });

        await videoRef.child('likes').transaction((currentLikes) => {
            if (isLiked) {
                return (currentLikes || 0) + 1;
            } else {
                return Math.max(0, (currentLikes || 1) - 1);
            }
        });

        if (isLiked && video.uploaderId && video.uploaderId !== userId) {
            const likerName = username ? `@${username}` : "Someone";
            await sendNotification(video.uploaderId, `❤️ <b>${likerName}</b> liked your reel!`);
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/video/view', async (req, res) => {
    const { videoId, userId } = req.body;
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    try {
        const videoRef = db.ref(`mini_app_videos/${videoId}`);
        const videoSnap = await videoRef.once('value');
        const video = videoSnap.val();

        if (!video) return res.status(404).json({ error: "Video not found" });

        await videoRef.child('views').transaction((currentViews) => (currentViews || 0) + 1);

        if (video.uploaderId && video.uploaderId !== userId) {
            await sendNotification(video.uploaderId, `👁️ Someone watched your reel!`);
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/video/save', async (req, res) => {
    const { videoId, userId, isSaved } = req.body;
    if (!videoId || !userId) return res.status(400).json({ error: "Missing parameters" });

    try {
        const videoSnap = await db.ref(`mini_app_videos/${videoId}`).once('value');
        const video = videoSnap.val();

        if (!video) return res.status(404).json({ error: "Video not found" });

        if (isSaved) {
            await bot.sendVideo(userId, video.fileId, {
                caption: `💾 <b>Saved Reel!</b>\n\nSaved directly from mini app.`,
                parse_mode: 'HTML'
            });

            if (video.uploaderId && video.uploaderId !== userId) {
                await sendNotification(video.uploaderId, `💾 Someone saved your reel directly in chat!`);
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/video/report', async (req, res) => {
    const { videoId, userId, username } = req.body;
    if (!videoId) return res.status(400).json({ error: "Missing parameters" });

    try {
        const videoSnap = await db.ref(`mini_app_videos/${videoId}`).once('value');
        const video = videoSnap.val();

        if (!video) return res.status(404).json({ error: "Video not found" });

        const reporterName = username ? `@${username}` : "Unknown User";
        const adminMsg = `⚠️ <b>Video Report Alert!</b>\n\n👤 <b>Reporter:</b> ${reporterName} (ID: ${userId})\n🆔 <b>Reel ID:</b> ${videoId}`;

        await bot.sendMessage(ADMIN_ID, adminMsg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "❌ Remove Video from Server", callback_data: `remove_vid_${videoId}` }
                    ]
                ]
            }
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/user/settings', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
        const snap = await db.ref(`users/${userId}/settings`).once('value');
        const settings = snap.val() || { uploadingReels: true, notifications: true };
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/user/settings', async (req, res) => {
    const { userId, uploadingReels, notifications } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
        await db.ref(`users/${userId}/settings`).set({
            uploadingReels: uploadingReels !== false,
            notifications: notifications !== false
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

async function getUserLang(chatId) {
    const snap = await db.ref(`users/${chatId}/lang`).once('value');
    return snap.val() || 'en'; 
}

async function trackUser(chatId) {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7);
    
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

bot.on('channel_post', async (msg) => {
    const targetChannel = TARGET_CHANNEL;

    if (msg.chat && msg.chat.username && msg.chat.username.toLowerCase() === targetChannel.toLowerCase()) {
        if (msg.video) {
            try {
                const messageId = msg.message_id;
                const dbRef = db.ref(`mini_app_videos/${messageId}`);
                const snap = await dbRef.once('value');
                if (!snap.exists()) {
                    const video = msg.video;
                    const fileId = video.file_id;
                    const fileSize = video.file_size || 0;
                    const caption = msg.caption || "";

                    let uploaderId = msg.chat.id.toString();
                    let uploaderName = `@${msg.chat.username}` || msg.chat.title || "Reels Uploader";
                    let uploaderPic = "https://via.placeholder.com/150";

                    await dbRef.set({
                        fileId: fileId,
                        fileSize: fileSize,
                        caption: "",
                        likes: 0,
                        views: 0,
                        uploaderId: uploaderId,
                        uploaderName: uploaderName,
                        uploaderPic: uploaderPic,
                        timestamp: admin.database.ServerValue.TIMESTAMP
                    });
                }
            } catch (err) {
                console.error("Secondary channel post sync error:", err.message);
            }
        }
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    await trackUser(chatId).catch(() => {});

    if (text === "🇧🇩 বাংলা / 🇬🇧 English") {
        const currentLang = await getUserLang(chatId);
        const newLang = currentLang === 'bn' ? 'en' : 'bn';
        await db.ref(`users/${chatId}/lang`).set(newLang);
        const str = strings[newLang];
        return bot.sendMessage(chatId, str.lang_switched, chatBoxConfig);
    }

    if (text === '/start') {
        try {
            const lang = await getUserLang(chatId);
            const str = strings[lang];

            const snap = await db.ref('admin_settings').once('value');
            const data = snap.val() || {};
            const welcomeMsg = data.welcomeText || str.welcome;
            const welcomeImg = data.welcomeImage || "https://telegra.ph/file/default.jpg";

            // Watch Video-র সাথে Language change option-টিও ইনলাইন কিবোর্ডে যুক্ত করা হয়েছে
            const inlineKeyboard = [
                [{ text: str.watch_btn, url: "https://t.me/SnapSavingBot/reels" }],
                [{ text: str.lang_btn, callback_data: lang === 'en' ? 'setlang_bn' : 'setlang_en' }]
            ];

            try {
                await bot.sendPhoto(chatId, welcomeImg, {
                    caption: welcomeMsg,
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
            } catch (imgErr) {
                await bot.sendMessage(chatId, welcomeMsg, {
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
            }

            // কিবোর্ড যেন মুছে না যায় বা চলে না যায় সেজন্য স্থায়ী মেসেজ ও কিবোর্ড পাঠানো হচ্ছে
            const helperText = lang === 'bn'
                ? "👇 নিচের বাটন থেকে আপনার ভাষা পরিবর্তন করতে পারেন অথবা যেকোনো ভিডিও লিংক পাঠান।"
                : "👇 You can change your language using the button below or send any video link to download.";
            
            await bot.sendMessage(chatId, helperText, chatBoxConfig);

        } catch (e) { console.error("Start command processing error:", e); }
    }

    if (text === '/settings') {
        const lang = await getUserLang(chatId);
        const str = strings[lang];
        const keyboard = await getSettingsKeyboard(chatId);
        return bot.sendMessage(chatId, str.settings_title, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }

    if (text.startsWith('http')) {
        const lang = await getUserLang(chatId);
        const str = strings[lang];

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
            buttons.push([{ text: str.verify, callback_data: "verify_join" }]);

            return bot.sendMessage(chatId, `⚠️ **${str.must_join}**`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
        processDownload(chatId, text, msg.message_id, msg);
    }
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const callbackData = q.data;
    const lang = await getUserLang(chatId);
    const str = strings[lang];

    if (callbackData === "setlang_bn" || callbackData === "setlang_en") {
        const newLang = callbackData === "setlang_bn" ? 'bn' : 'en';
        await db.ref(`users/${chatId}/lang`).set(newLang);
        const updatedStr = strings[newLang];
        
        // যদি /settings মেসেজ থেকে ভাষা পরিবর্তন করা হয়
        if (q.message.text && q.message.text.includes(strings[lang].settings_title)) {
            const keyboard = await getSettingsKeyboard(chatId);
            await bot.editMessageText(updatedStr.settings_title, {
                chat_id: chatId,
                message_id: q.message.message_id,
                parse_mode: 'HTML',
                reply_markup: keyboard
            }).catch(() => {});
        } else {
            // ইনলাইন কিবোর্ড থেকে ভাষা পরিবর্তন করলে সেই মেসেজটি আপডেট করা হচ্ছে
            if (q.message.reply_markup && q.message.reply_markup.inline_keyboard) {
                const oldKeyboard = q.message.reply_markup.inline_keyboard;
                const newKeyboard = oldKeyboard.map(row => {
                    return row.map(btn => {
                        if (btn.callback_data === 'setlang_bn' || btn.callback_data === 'setlang_en') {
                            return {
                                text: updatedStr.lang_btn,
                                callback_data: newLang === 'en' ? 'setlang_bn' : 'setlang_en'
                            };
                        }
                        if (btn.text === strings[lang].watch_btn) {
                            return { ...btn, text: updatedStr.watch_btn };
                        }
                        return btn;
                    });
                });
                
                await bot.editMessageReplyMarkup({ inline_keyboard: newKeyboard }, {
                    chat_id: chatId,
                    message_id: q.message.message_id
                }).catch(() => {});
            }
        }

        await bot.answerCallbackQuery(q.id, { text: updatedStr.lang_switched });
        
        // মূল চ্যাটবক্স কিবোর্ডটি আপডেট রাখার জন্য মেসেজ পাঠানো হচ্ছে
        await bot.sendMessage(chatId, updatedStr.lang_switched, chatBoxConfig);
        return;
    }

    if (callbackData === "toggle_notify") {
        const settingsSnap = await db.ref(`users/${chatId}/settings`).once('value');
        const settings = settingsSnap.val() || { uploadingReels: true, notifications: true };
        const newNotify = settings.notifications === false;

        await db.ref(`users/${chatId}/settings`).update({ notifications: newNotify });
        const keyboard = await getSettingsKeyboard(chatId);
        
        await bot.editMessageReplyMarkup(keyboard, {
            chat_id: chatId,
            message_id: q.message.message_id
        }).catch(() => {});

        await bot.answerCallbackQuery(q.id, { text: "Notifications updated!" });
        return;
    }

    if (callbackData === "toggle_upload") {
        const settingsSnap = await db.ref(`users/${chatId}/settings`).once('value');
        const settings = settingsSnap.val() || { uploadingReels: true, notifications: true };
        const newUpload = settings.uploadingReels === false;

        await db.ref(`users/${chatId}/settings`).update({ uploadingReels: newUpload });
        const keyboard = await getSettingsKeyboard(chatId);
        
        await bot.editMessageReplyMarkup(keyboard, {
            chat_id: chatId,
            message_id: q.message.message_id
        }).catch(() => {});

        await bot.answerCallbackQuery(q.id, { text: "Reels Upload settings updated!" });
        return;
    }

    if (callbackData.startsWith("remove_vid_")) {
        if (q.from.id.toString() !== ADMIN_ID) {
            return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized!", show_alert: true });
        }
        
        const messageId = callbackData.replace("remove_vid_", "");
        try {
            await db.ref(`mini_app_videos/${messageId}`).remove();
            
            await bot.editMessageText(`✅ <b>ভিডিওটি অ্যাপ এবং সার্ভার থেকে রিমুভ করা হয়েছে!</b>`, {
                chat_id: q.message.chat.id,
                message_id: q.message.message_id,
                parse_mode: 'HTML'
            });
            
            await bot.answerCallbackQuery(q.id, { text: "Removed successfully from app!" });
        } catch (err) {
            await bot.answerCallbackQuery(q.id, { text: "Error deleting video.", show_alert: true });
        }
        return;
    }

    if (callbackData === "verify_join") {
        const missingChannels = await getMissingChannels(chatId);
        if (missingChannels.length === 0) {
            await bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
            const link = userSessions[chatId];
            if (link) processDownload(chatId, link, null, q.message);
        } else {
            bot.answerCallbackQuery(q.id, { text: str.not_joined, show_alert: true });
        }
    }
    
    if (callbackData === "send_audio") {
        const audioUrl = audioCache[chatId];
        if (audioUrl) {
            bot.answerCallbackQuery(q.id, { text: str.sending_audio });
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

async function processDownload(chatId, url, msgId, rawMsg) {
    const lang = await getUserLang(chatId);
    const str = strings[lang];

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

        if (data && data.medias) {
            isDownloaded = true;
            clearInterval(interval);

            await bot.editMessageText(`🪄 Success [${getProgressBar(100)}] 100%`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            }).catch(() => {});

            await db.ref('stats/total_downloads').transaction((current) => (current || 0) + 1);

            const video = data.medias.find(m => m.type === 'video') || data.medias[0];
            const audio = data.medias.find(m => m.type === 'audio');
            if (audio) audioCache[chatId] = audio.url;

            let adTextCaption = "";
            try {
                const adminSnap = await db.ref('admin_settings').once('value');
                const settings = adminSnap.val() || {};
                const ads = settings.ads || [];
                if (ads.length > 0) {
                    const randomAd = ads[Math.floor(Math.random() * ads.length)];
                    adTextCaption = `\n\nAds <a href="${randomAd.link}"><b>${randomAd.text}</b></a>`;
                }
            } catch (adErr) {}

            const inlineKeyboardButtons = [];
            if (audio) {
                inlineKeyboardButtons.push([{ text: "Audio 🎵", callback_data: "send_audio" }]);
            }
            // ভিডিও মেসেজের ইনলাইনে ভাষা পরিবর্তনের বাটন যুক্ত করা হয়েছে
            inlineKeyboardButtons.push([{ text: str.lang_btn, callback_data: lang === 'en' ? 'setlang_bn' : 'setlang_en' }]);

            const videoOpts = { 
                caption: `Use This - @SnapSavingBot` + adTextCaption,
                parse_mode: 'HTML',
                reply_markup: inlineKeyboardButtons.length > 0 ? { inline_keyboard: inlineKeyboardButtons } : undefined
            };

            const sentMsg = await bot.sendVideo(chatId, video.url, videoOpts);

            try {
                const userSettingsSnap = await db.ref(`users/${chatId}/settings`).once('value');
                const settings = userSettingsSnap.val() || {};
                const uploadingReels = settings.uploadingReels !== false;

                if (uploadingReels) {
                    const profile = await getUserProfileInfo(chatId);
                    const uploaderUsername = rawMsg.from && rawMsg.from.username ? `@${rawMsg.from.username}` : (rawMsg.from && rawMsg.from.first_name || "Guest_User");
                    const videoSizeMB = sentMsg.video.file_size ? `${(sentMsg.video.file_size / (1024 * 1024)).toFixed(2)} MB` : "Unknown Size";
                    const uploadDateStr = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

                    const channelPost = await bot.sendVideo(`@${TARGET_CHANNEL}`, sentMsg.video.file_id, {
                        caption: `Uploading Reels...`
                    });
                    const messageId = channelPost.message_id;
                    const finalAppLink = `https://t.me/SnapSavingBot/reels?startapp=${messageId}`;

                    const channelCaption = `Video link : ${finalAppLink}\n` +
                                           `Video Size : ${videoSizeMB}\n` +
                                           `Uploder : ${uploaderUsername}\n` +
                                           `Upload date : ${uploadDateStr}`;

                    await bot.editMessageCaption(channelCaption, {
                        chat_id: `@${TARGET_CHANNEL}`,
                        message_id: messageId
                    });

                    await db.ref(`mini_app_videos/${messageId}`).set({
                        fileId: sentMsg.video.file_id,
                        fileSize: sentMsg.video.file_size || 0,
                        caption: "", 
                        likes: 0,
                        views: 0,
                        uploaderId: chatId.toString(),
                        uploaderName: uploaderUsername,
                        uploaderPic: profile.photoUrl,
                        timestamp: admin.database.ServerValue.TIMESTAMP
                    });

                    const adminMsg = `⚠️ <b>নতুন ভিডিও আপলোড হয়েছে!</b>\n\n` +
                                     `🔗 <b>Video link :</b> ${finalAppLink}\n` +
                                     `📦 <b>Video size :</b> ${videoSizeMB}\n` +
                                     `📅 <b>Upload date :</b> ${uploadDateStr}`;

                    await bot.sendMessage(ADMIN_ID, adminMsg, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "❌ Remove this video", callback_data: `remove_vid_${messageId}` }]
                            ]
                        }
                    });
                }
            } catch (uploadErr) {
                console.error("Direct db sync alert failed:", uploadErr.message);
            }
            
            setTimeout(() => {
                bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            }, 1000);
        } else {
            // যদি রেসপন্স ডাটা না পাওয়া যায়
            isDownloaded = true;
            clearInterval(interval);
            
            // প্রথমে লোডিং (⏳) মেসেজটি ডিলেট করা হচ্ছে
            await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            
            // তারপর সমস্যা সম্পর্কিত টেক্সট পাঠানো হচ্ছে
            await bot.sendMessage(chatId, str.error_fetch, chatBoxConfig);
        }
    } catch (e) {
        // অতিরিক্ত সাইজ বা যেকোনো ত্রুটিজনিত কারণে ডাউনলোডে সমস্যা হলে
        isDownloaded = true;
        clearInterval(interval);
        
        // প্রথমে লোডিং (⏳) মেসেজটি ডিলেট করা হচ্ছে
        await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        
        // তারপর সমস্যা সম্পর্কিত টেক্সট পাঠানো হচ্ছে
        await bot.sendMessage(chatId, str.error_fetch, chatBoxConfig);
    }
}

app.listen(PORT, () => { console.log(`Server started on port ${PORT}`); });
