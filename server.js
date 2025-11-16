const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 让 Express 能解析 JSON 请求体
app.use(express.json());

// 静态文件目录：public 里的文件可以直接通过浏览器访问
app.use(express.static(path.join(__dirname, 'public')));

// 确保有 uploads 目录，用来存图片
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// 让 /uploads 下的文件可以被浏览器访问
app.use('/uploads', express.static(uploadDir));

// 配置 multer，保存图片到 uploads 目录
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname); // 原始扩展名
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
    fileSize: 5 * 1024 * 1024, // 最大 5MB
  },
});

// ====== 持久化 rooms 和 messages 到 data.json ======

const dataFile = path.join(__dirname, 'data.json');

// 用 let，这样可以在 loadData 里覆写
let rooms = [];     // { id, name, createdAt }
let messages = [];  // { id, roomId, userName, text, imageUrl, createdAt }

function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      const raw = fs.readFileSync(dataFile, 'utf-8');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.rooms)) rooms = parsed.rooms;
        if (Array.isArray(parsed.messages)) messages = parsed.messages;
        console.log(
          `Loaded ${rooms.length} rooms and ${messages.length} messages from data.json`
        );
      }
    } else {
      console.log('data.json not found, starting with empty data');
    }
  } catch (err) {
    console.error('Error loading data.json:', err);
  }
}

function saveData() {
  const payload = { rooms, messages };
  fs.writeFile(dataFile, JSON.stringify(payload, null, 2), (err) => {
    if (err) {
      console.error('Error saving data.json:', err);
    }
  });
}

// 启动时先尝试加载历史数据
loadData();

// ====== 内存里的在线用户：roomId -> { socketId: userName } ======

const roomUsers = {}; // { [roomId]: { [socketId]: userName } }

function getRoomUserNames(roomId) {
  const users = roomUsers[roomId] || {};
  return Object.values(users); // [userName, userName2, ...]
}

function broadcastRoomUsers(roomId) {
  const names = getRoomUserNames(roomId);
  io.to(roomId).emit('roomUsers', names);
}

// ====== 业务逻辑 ======

function findRoomByName(name) {
  return rooms.find((r) => r.name === name);
}

// 获取房间列表（支持 ?q= 关键字搜索）
app.get('/api/rooms', (req, res) => {
  const q = (req.query.q || '').trim();

  if (!q) {
    // 没有关键词就返回全部房间
    return res.json(rooms);
  }

  const matched = rooms.filter((r) => r.name.includes(q));
  res.json(matched);
});

// 创建房间（如果同名已存在就直接返回原来的）
app.post('/api/rooms', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  let existing = findRoomByName(name);
  if (existing) {
    return res.json(existing);
  }

  const room = {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    name,
    createdAt: new Date().toISOString(),
  };

  rooms.push(room);
  saveData(); // ★ 保存到 data.json

  res.status(201).json(room);
});

// 获取某个房间的历史消息
app.get('/api/rooms/:id/messages', (req, res) => {
  const { id } = req.params;
  const roomMessages = messages
    .filter((m) => m.roomId === id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  res.json(roomMessages);
});

// 图片上传接口
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有收到文件' });
  }
  const url = '/uploads/' + req.file.filename; // 浏览器可访问的地址
  res.json({ url });
});

// 处理上传相关错误
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === '只允许上传图片') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ====== WebSocket 部分：实时聊天 + 在线人数 ======

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

  // 加入房间（现在携带 roomId + userName）
  socket.on('joinRoom', (payload) => {
    let roomId;
    let userName = '游客';

    // 兼容老的写法：只传 roomId 字符串
    if (typeof payload === 'string') {
      roomId = payload;
    } else if (payload && typeof payload === 'object') {
      roomId = payload.roomId;
      if (payload.userName) userName = payload.userName;
    }

    if (!roomId) return;

    socket.join(roomId);

    // 记录在线用户
    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }
    roomUsers[roomId][socket.id] = userName;

    // 发历史消息给刚进来的这个人
    const history = messages
      .filter((m) => m.roomId === roomId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    socket.emit('roomHistory', history);

    // 广播房间在线用户列表
    broadcastRoomUsers(roomId);
  });

  // 收到消息（文字 + 图片）
  socket.on('sendMessage', (payload) => {
    const { roomId, userName, text, imageUrl } = payload || {};

    const cleanedText = (text || '').trim();
    const cleanedImageUrl = (imageUrl || '').trim();

    // 至少要有文字或者图片其中一个
    if (!roomId || (!cleanedText && !cleanedImageUrl)) {
      return;
    }

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      roomId,
      userName: userName || '游客',
      text: cleanedText,
      imageUrl: cleanedImageUrl,
      createdAt: new Date().toISOString(),
    };

    messages.push(msg);
    saveData(); // ★ 有新消息也保存一下

    // 发送给房间里所有人
    io.to(roomId).emit('newMessage', msg);
  });

  socket.on('disconnect', () => {
    console.log('user disconnected', socket.id);

    // 从所有房间里移除这个 socket
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
