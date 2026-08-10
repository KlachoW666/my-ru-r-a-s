const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { syncRustSkins, getSteamPlayerSummary, SKINS_FILE } = require('./services/steamSync');

const app = express();
const PORT = process.env.PORT || 3030;

// Path to public static directory
const PUBLIC_DIR = path.resolve(__dirname, 'public');

app.use(cors());
app.use(express.json());

// Request logging middleware for API calls
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

// Helper to load synced Steam skins
function getSyncedSkins() {
  if (fs.existsSync(SKINS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SKINS_FILE, 'utf8'));
      if (data.skins && data.skins.length > 0) return data.skins;
    } catch (e) {
      console.error('Failed to parse skins.json:', e.message);
    }
  }
  return [
    { id: "1", name: "AK-47 | Tempered", price: 4500, image: "/assets/battles/winner-boar.png", rarity: "mythic" },
    { id: "2", name: "LR-300 | Victoria", price: 1200, image: "/assets/battles/boar-ready.png", rarity: "legendary" },
    { id: "3", name: "MP5 | Cold Hunter", price: 350, image: "/assets/header/logo.webp", rarity: "rare" }
  ];
}

// --- MOCK DATA DEFINITIONS USING LOCAL & SYNCED STEAM ASSETS ---

const mockAvatar = "/avatars/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg";
const mockLogo = "/assets/header/logo.webp";
const mockBoarWinner = "/assets/battles/winner-boar.png";
const mockBoarReady = "/assets/battles/boar-ready.png";
const mockRafflePoster = "/assets/raffle/mega-poster.webp";

const mockConfig = {
  modes: [
    { name: "case_opening", enabled: true },
    { name: "battle", enabled: true },
    { name: "upgrade", enabled: true },
    { name: "deposit_chain", enabled: true },
    { name: "online_badge", enabled: true }
  ],
  topDropsVisible: true,
  isMaintenance: false,
  audio: {
    click: "/audio/click.ogg",
    open: "/audio/open.mp3",
    win: "/audio/win.wav",
    spin: "/audio/spin.mp3",
    roulette: "/audio/roulette.ogg",
    battle: "/audio/battle.ogg",
    upgrade: "/audio/upgrade.mp3"
  }
};

let mockUser = {
  id: "76561198991234567",
  steamId: "76561198991234567",
  username: "Kaban_Pro",
  name: "Kaban_Pro",
  avatar: mockAvatar,
  avatarFull: mockAvatar,
  balance: 5420.50,
  currency: "RUB",
  status: "active",
  tradeLink: "https://steamcommunity.com/tradeoffer/new/?partner=12345678&token=abcDEF12",
  isUserAdmin: true,
  canAccessStreamerStatistics: true,
  createdAt: new Date().toISOString()
};

function buildMockCases() {
  const skins = getSyncedSkins();
  return [
    {
      id: "rust-starter",
      slug: "rust-starter",
      name: "Халявный Кабан",
      category: "Популярные",
      price: 49,
      oldPrice: 99,
      image: mockLogo,
      items: skins.slice(0, 5)
    },
    {
      id: "weapon-set",
      slug: "weapon-set",
      name: "Оружейный Сет",
      category: "Rust Базовые",
      price: 199,
      oldPrice: 299,
      image: mockLogo,
      items: skins.slice(2, 8)
    },
    {
      id: "secret-drop",
      slug: "secret-drop",
      name: "Тайный Дроп",
      category: "Тайные",
      price: 499,
      oldPrice: 750,
      image: mockLogo,
      items: skins.slice(0, 4)
    }
  ];
}

const mockBanners = [
  {
    id: "banner-tiktok",
    title: "Делай нарезки\nлутай ещё больше",
    description: "Конкурс моментов в тиктоке",
    buttonText: "Участвовать",
    buttonColor: "#e54b38",
    buttonAction: "url",
    buttonValue: "/giveaway",
    glowColor: "#84c424",
    borderColor: "#4d7318",
    background: "radial-gradient(ellipse at 80% 50%, #2e4a0d 0%, #0d1405 100%)",
    image: mockBoarWinner,
    video: "/assets/raffle/mega-loop.mp4"
  },
  {
    id: "banner-battles",
    title: "Кейс-Баттлы\nKaban.gg",
    description: "Замесы 1v1, 2v2 и 4v4",
    buttonText: "Играть",
    buttonColor: "#84c424",
    buttonAction: "url",
    buttonValue: "/crate-pvp",
    glowColor: "#84c424",
    borderColor: "#4d7318",
    background: "radial-gradient(ellipse at 80% 50%, #2e4a0d 0%, #0d1405 100%)",
    image: mockBoarReady,
    video: "/assets/raffle/mega-loop.webm"
  }
];

const mockStats = {
  onlineCount: 412,
  openedCasesCount: 128450,
  upgradesCount: 45120,
  battlesCount: 18920
};

// --- STEAM SYNC ADMIN & PUBLIC ENDPOINTS ---

// Admin Trigger Steam Skins Sync
app.post(['/api/v1/admin/sync-skins', '/api/v1/skins/sync'], async (req, res) => {
  try {
    const count = req.body?.count || 50;
    const result = await syncRustSkins(count);
    res.json({
      status: "success",
      message: `Синхронизировано ${result.skins.length} скинов из Steam Community Market`,
      data: result
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Get Synced Skins Catalog
app.get('/api/v1/skins', (req, res) => {
  const skins = getSyncedSkins();
  res.json({ status: "success", count: skins.length, data: skins });
});

// --- MOCK API ROUTE HANDLERS ---

// Auth endpoints
app.all(['/api/v1/auth/refresh', '/api/v1/auth/me', '/api/v1/auth/steam', '/api/v1/auth/login/email', '/api/v1/auth/register/email'], (req, res) => {
  res.json({ status: "success", data: { user: mockUser, token: "mock_token_12345" } });
});

app.all('/api/v1/auth/logout', (req, res) => {
  res.json({ status: "success", message: "Logged out" });
});

// User profile endpoints
app.get(['/api/v1/user', '/api/v1/user/me', '/api/v1/users/me', '/api/v1/profile'], (req, res) => {
  res.json({ status: "success", data: mockUser });
});

app.get('/api/v1/user/stats', (req, res) => {
  res.json({ status: "success", data: { openedCases: 42, wonAmount: 18450, totalBattles: 15 } });
});

app.get('/api/v1/user/ban-status', (req, res) => {
  res.json({ status: "success", data: { banned: false } });
});

app.get('/api/v1/user/favorites', (req, res) => {
  const cases = buildMockCases();
  res.json({ status: "success", data: [cases[0].id] });
});

app.put(['/api/v1/user/tradeurl', '/api/v1/user/display-name', '/api/v1/user/avatar'], (req, res) => {
  if (req.body.tradeLink) mockUser.tradeLink = req.body.tradeLink;
  if (req.body.username) mockUser.username = req.body.username;
  res.json({ status: "success", data: mockUser });
});

// Config endpoints
app.get(['/api/v1/config', '/api/v1/config/games', '/api/v1/game/config'], (req, res) => {
  res.json({ status: "success", data: { config: mockConfig, modes: mockConfig.modes } });
});

app.get(['/api/v1/config/socials', '/config/socials'], (req, res) => {
  res.json({
    status: "success",
    data: {
      links: [
        { name: "Telegram", url: "https://t.me/kabangg" },
        { name: "VK", url: "https://vk.com/kabangg" }
      ]
    }
  });
});

// Promo code endpoints
app.post('/api/v1/promo/redeem', (req, res) => {
  const { code } = req.body || {};
  mockUser.balance += 250;
  res.json({
    status: "success",
    data: {
      success: true,
      message: `Промокод "${code || 'KABAN'}" успешно применён! +250 ₽ на баланс.`,
      newBalance: mockUser.balance
    }
  });
});

app.post('/api/v1/promo/validate', (req, res) => {
  res.json({ status: "success", data: { valid: true, bonusPercent: 15 } });
});

app.get('/api/v1/promo/active', (req, res) => {
  res.json({ status: "success", data: null });
});

// Banners
app.get(['/api/v1/banners', '/api/v1/banner', '/banners'], (req, res) => {
  res.json({
    status: "success",
    data: {
      banners: mockBanners
    }
  });
});

// Live recent drops
app.get(['/api/v1/live/recent', '/api/v1/drops/recent'], (req, res) => {
  const skins = getSyncedSkins();
  const recent = skins.slice(0, 5).map((s, idx) => ({
    id: `drop-${idx + 1}`,
    user: `Player_${idx + 1}`,
    avatar: mockAvatar,
    itemName: s.name,
    itemPrice: s.price,
    image: s.image,
    rarity: s.rarity
  }));
  res.json({ status: "success", data: recent });
});

// Stats
app.get(['/api/v1/stats/global', '/api/v1/stats'], (req, res) => {
  res.json({ status: "success", data: mockStats });
});

// Deposit chain state
app.get('/api/v1/deposit-chain/state', (req, res) => {
  res.json({ status: "success", data: { active: true, step: 1 } });
});

// Upgrader endpoints
app.get(['/api/v1/upgrader/items', '/api/v1/upgrader'], (req, res) => {
  const skins = getSyncedSkins();
  res.json({ status: "success", data: skins });
});

app.post('/api/v1/upgrader/place', (req, res) => {
  const skins = getSyncedSkins();
  const won = Math.random() > 0.4;
  const targetItem = skins[0];
  if (won) mockUser.balance += targetItem.price;
  res.json({
    status: "success",
    data: {
      win: won,
      roll: won ? 85.5 : 12.3,
      item: targetItem,
      newBalance: mockUser.balance
    }
  });
});

app.post('/api/v1/upgrader/offer/accept', (req, res) => {
  res.json({ status: "success", message: "Предмет успешно получен" });
});

// Cases & Case Opening
app.get('/api/v1/cases', (req, res) => {
  res.json({ status: "success", data: buildMockCases() });
});

app.get('/api/v1/cases/series', (req, res) => {
  res.json({ status: "success", data: [] });
});

app.get('/api/v1/cases/limited/remaining', (req, res) => {
  res.json({ status: "success", data: {} });
});

app.get('/api/v1/cases/secret/state', (req, res) => {
  res.json({ status: "success", data: { enabled: true } });
});

app.get('/api/v1/cases/:slug/grid', (req, res) => {
  const skins = getSyncedSkins();
  res.json({ status: "success", data: skins });
});

app.get('/api/v1/cases/:slug/best', (req, res) => {
  const skins = getSyncedSkins();
  res.json({ status: "success", data: skins[0] });
});

app.get('/api/v1/cases/:slug', (req, res) => {
  const cases = buildMockCases();
  const c = cases.find(x => x.slug === req.params.slug) || cases[0];
  res.json({ status: "success", data: c });
});

app.post('/api/v1/cases/open', (req, res) => {
  const skins = getSyncedSkins();
  const winningItem = skins[Math.floor(Math.random() * skins.length)];
  mockUser.balance = Math.max(0, mockUser.balance - 49);
  res.json({
    status: "success",
    data: {
      item: winningItem,
      newBalance: mockUser.balance
    }
  });
});

// Giveaways endpoints
app.get('/api/v1/giveaways/active-mega', (req, res) => {
  const skins = getSyncedSkins();
  res.json({
    status: "success",
    data: {
      id: "mega-1",
      title: "Мега Розыгрыш Месяца",
      prize: skins[0]?.name || "High Quality Crate",
      price: skins[0]?.price || 2500,
      participantsCount: 892,
      endsAt: new Date(Date.now() + 604800000).toISOString(),
      image: skins[0]?.image || mockRafflePoster
    }
  });
});

app.get(['/api/v1/giveaway', '/api/v1/giveaways'], (req, res) => {
  const cases = buildMockCases();
  res.json({
    status: "success",
    data: [
      {
        id: "g-1",
        title: "Ежедневный Розыгрыш AK-47",
        prize: "AK-47 | Tempered",
        price: 4500,
        participantsCount: 142,
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        image: mockBoarWinner
      }
    ]
  });
});

app.post('/api/v1/giveaways/:id/join', (req, res) => {
  res.json({ status: "success", message: "Вы успешно вступили в розыгрыш!" });
});

// Crate PVP / Battles endpoints
app.get(['/api/v1/crate-pvp', '/api/v1/battles'], (req, res) => {
  const cases = buildMockCases();
  res.json({
    status: "success",
    data: [
      {
        id: "b-1",
        name: "Замес #1",
        cases: [cases[0]],
        totalPrice: 98,
        playersCount: 2,
        maxPlayers: 2,
        status: "waiting",
        creator: mockUser
      }
    ]
  });
});

app.post('/api/v1/battles/create', (req, res) => {
  const cases = buildMockCases();
  const newBattle = {
    id: "b-" + Date.now(),
    name: "Замес #2",
    cases: [cases[0]],
    totalPrice: 98,
    playersCount: 1,
    maxPlayers: 2,
    status: "waiting",
    creator: mockUser
  };
  res.json({ status: "success", data: newBattle });
});

app.post(['/api/v1/battles/:id/join', '/api/v1/battles/:id/add-bot'], (req, res) => {
  res.json({ status: "success", message: "Игрок подключён к баттлу" });
});

// Wallet & Deposit endpoints
app.get(['/api/v1/wallet', '/api/v1/wallet/config'], (req, res) => {
  res.json({
    status: "success",
    data: {
      balance: mockUser.balance,
      currency: "RUB",
      paymentMethods: [
        { id: "card", name: "Банковская карта RUB", icon: "/assets/wallet/pm-cards.svg" },
        { id: "sbp", name: "СБП", icon: "/assets/wallet/sbp.svg" },
        { id: "crypto", name: "Криптовалюта (USDT / TON / BTC)", icon: "/assets/wallet/pm-crypto.svg" }
      ]
    }
  });
});

app.get('/api/v1/wallet/transactions', (req, res) => {
  res.json({
    status: "success",
    data: [
      { id: "tx-1", type: "deposit", amount: 1000, status: "completed", date: new Date().toISOString() },
      { id: "tx-2", type: "case_open", amount: -49, status: "completed", date: new Date().toISOString() }
    ]
  });
});

app.post('/api/v1/wallet/deposit/card', (req, res) => {
  const amount = req.body.amount || 500;
  mockUser.balance += amount;
  res.json({
    status: "success",
    data: {
      url: "http://localhost:3030/wallet",
      newBalance: mockUser.balance,
      message: `Пополнение на ${amount} ₽ прошло успешно!`
    }
  });
});

app.post('/api/v1/wallet/withdraw', (req, res) => {
  res.json({ status: "success", message: "Заявка на вывод создана успешно" });
});

// Wildcard API fallback
app.use('/api/v1', (req, res) => {
  res.json({ status: "success", data: [] });
});

// --- MEDIA & STATIC ASSETS ROUTES ---

// Audio & Sound Effects Directory
app.use('/audio', express.static(path.join(PUBLIC_DIR, 'audio'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg');
    if (filePath.endsWith('.ogg')) res.setHeader('Content-Type', 'audio/ogg');
    if (filePath.endsWith('.wav')) res.setHeader('Content-Type', 'audio/wav');
  }
}));

app.use('/sounds', express.static(path.join(PUBLIC_DIR, 'sounds')));

// Steam Avatars
app.use('/avatars.steamstatic.com', express.static(path.join(PUBLIC_DIR, 'avatars')));
app.use('/avatars', express.static(path.join(PUBLIC_DIR, 'avatars')));

// Subdirectory asset routes
app.use('/icons', express.static(path.join(PUBLIC_DIR, 'icons')));
app.use('/png', express.static(path.join(PUBLIC_DIR, 'png')));
app.use('/svg', express.static(path.join(PUBLIC_DIR, 'svg')));
app.use('/image', express.static(path.join(PUBLIC_DIR, 'image')));
app.use('/packs', express.static(path.join(PUBLIC_DIR, 'packs')));

// Main assets directory
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

// Static root files with known extensions only
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const ext = path.extname(req.path);
  if (ext && ext !== '.html') {
    return express.static(PUBLIC_DIR, { fallthrough: true, index: false })(req, res, next);
  }
  next();
});

// SPA History Fallback (Return index.html with text/html header)
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.type('html').sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

// Automatic initial Steam sync on startup if skins.json missing or older than 1 hour
(async () => {
  if (!fs.existsSync(SKINS_FILE)) {
    try {
      await syncRustSkins(50);
    } catch (e) {
      console.error('[Startup] Steam sync notice:', e.message);
    }
  }
})();

app.listen(PORT, () => {
  console.log(`================================================`);
  console.log(` NewCasesRust Steam Synced App running at: http://localhost:${PORT}`);
  console.log(` Serving production static files from: ${PUBLIC_DIR}`);
  console.log(` Live Steam API Key: F08021AF0F2223EBD08820781CBC2B2D connected!`);
  console.log(`================================================`);
});
