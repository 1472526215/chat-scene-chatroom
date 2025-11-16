const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 解析 JSON 请求体
app.use(express.json());

// 静态文件目录
app.use(express.static(path.join(__dirname, 'public')));

// ====== 上传图片相关（还是存本地 uploads） ======

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, baseName + ext);
  },
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('只允许上传图片'));
    }
    cb(null, true);
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// ====== PostgreSQL 连接池 ======

if (!process.env.DATABASE_URL) {
  console.error('⚠️ DATABASE_URL 没有配置，服务器仍会启动，但所有数据库操作都会失败。');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false } // Render 的 Postgres 需要 SSL
    : undefined,
});

// 启动时保证表存在（双保险，和你手动执行那两条 SQL 一致）
async function ensureTables() {
  const sql = `
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL,
    text TEXT,
    image_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `;
  await pool.query(sql);
  console.log('DB tables are ready');
}

ensureTables().catch((err) => {
  console.error('Error ensuring tables:', err);
});

// 生成 ID 的小工具
function genId() {
  return Date.now().toString() + Math.random().toString(36).slice(2);
}

// ====== 在线用户（内存里）：roomId -> { socketId: userName } ======

const roomUsers = {};

function getRoomUserNames(roomId) {
  const users = roomUsers[roomId] || {};
  return Object.values(users);
}

function broadcastRoomUsers(roomId) {
  const names = getRoomUserNames(roomId);
  io.to(roomId).emit('roomUsers', names);
}

// ====== 业务接口：房间 & 消息 ======

// GET /api/rooms?q=关键字
app.get('/api/rooms', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (!q) {
      result = await pool.query(
        'SELECT id, name, created_at FROM rooms ORDER BY created_at DESC'
      );
    } else {
      result = await pool.query(
        'SELECT id, name, created_at FROM rooms WHERE name LIKE $1 ORDER BY created_at DESC',
        [`%${q}%`]
      );
    }

    const rooms = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
    }));

    res.json(rooms);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /api/rooms  body: { name }
app.post('/api/rooms', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    // 先看有没有同名房间
    let result = await pool.query(
      'SELECT id, name, created_at FROM rooms WHERE name = $1 LIMIT 1',
      [name]
    );

    if (result.rows.length > 0) {
      const r = result.rows[0];
      return res.json({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
      });
    }

    // 没有就创建
    const id = genId();
    result = await pool.query(
      'INSERT INTO rooms (id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [id, name]
    );

    const room = {
      id: result.rows[0].id,
      name: result.rows[0].name,
      createdAt: result.rows[0].created_at,
    };

    res.status(201).json(room);
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /api/rooms/:id/messages  获取历史消息
app.get('/api/rooms/:id/messages', async (req, res) => {
  const roomId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, room_id, user_name, text, image_url, created_at
       FROM messages
       WHERE room_id = $1
       ORDER BY created_at ASC`,
      [roomId]
    );

    const msgs = result.rows.map((m) => ({
      id: m.id,
      roomId: m.room_id,
      userName: m.user_name,
      text: m.text,
      imageUrl: m.image_url,
      createdAt: m.created_at,
    }));

    res.json(msgs);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// 图片上传接口
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有收到文件' });
  }
  const url = '/uploads/' + req.file.filename;
  res.json({ url });
});

// 上传错误处理
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === '只允许上传图片') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ====== WebSocket：聊天 + 在线人数 ======

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

  // 加入房间（携带 roomId + userName）
  socket.on('joinRoom', async (payload) => {
    let roomId;
    let userName = '游客';

    if (typeof payload === 'string') {
      roomId = payload;
    } else if (payload && typeof payload === 'object') {
      roomId = payload.roomId;
      if (payload.userName) userName = payload.userName;
    }

    if (!roomId) return;

    socket.join(roomId);

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }
    roomUsers[roomId][socket.id] = userName;

    try {
      const result = await pool.query(
        `SELECT id, room_id, user_name, text, image_url, created_at
         FROM messages
         WHERE room_id = $1
         ORDER BY created_at ASC`,
        [roomId]
      );

      const history = result.rows.map((m) => ({
        id: m.id,
        roomId: m.room_id,
        userName: m.user_name,
        text: m.text,
        imageUrl: m.image_url,
        createdAt: m.created_at,
      }));

      socket.emit('roomHistory', history);
    } catch (err) {
      console.error('Error loading room history:', err);
    }

    broadcastRoomUsers(roomId);
  });

  // 收到消息
  socket.on('sendMessage', async (payload) => {
    const { roomId, userName, text, imageUrl } = payload || {};

    const cleanedText = (text || '').trim();
    const cleanedImageUrl = (imageUrl || '').trim();

    if (!roomId || (!cleanedText && !cleanedImageUrl)) {
      return;
    }

    const id = genId();
    const createdAt = new Date();

    try {
      await pool.query(
        `INSERT INTO messages (id, room_id, user_name, text, image_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          roomId,
          userName || '游客',
          cleanedText || null,
          cleanedImageUrl || null,
          createdAt,
        ]
      );
    } catch (err) {
      console.error('Error saving message:', err);
      // 即使保存失败，也不要广播，以免前端以为成功了
      return;
    }

    const msg = {
      id,
      roomId,
      userName: userName || '游客',
      text: cleanedText,
      imageUrl: cleanedImageUrl,
      createdAt: createdAt.toISOString(),
    };

    io.to(roomId).emit('newMessage', msg);
  });

  socket.on('disconnect', () => {
    console.log('user disconnected', socket.id);
    for (const [roomId, users] of Object.entries(roomUsers)) {
      if (users[socket.id]) {
        delete users[socket.id];
        broadcastRoomUsers(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
