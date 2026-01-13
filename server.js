const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Конфигурация Railway
const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';

// Мидлвэры
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ?
      process.env.ALLOWED_ORIGINS.split(',') :
      ['http://localhost:3000', 'https://*.railway.app'],
  credentials: true
}));
app.use(express.json());

// Лимит запросов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Подключение к БД
let pool;
let isDatabaseConnected = false;

async function initializeDatabase() {
  try {
    console.log('🔍 Проверяем DATABASE_URL:', DATABASE_URL ? 'присутствует' : 'отсутствует');

    if (!DATABASE_URL) {
      console.log('⚠️ DATABASE_URL не найден. Используем мок-режим.');
      return;
    }

    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    // Тестовое подключение
    const client = await pool.connect();
    console.log('✅ PostgreSQL подключен успешно!');

    // Создаем таблицы если их нет
    await createTablesIfNotExist(client);

    client.release();
    isDatabaseConnected = true;

  } catch (error) {
    console.error(`❌ Ошибка подключения к PostgreSQL: ${error.message}`);
    console.log('📝 Приложение будет работать в мок-режиме');
    isDatabaseConnected = false;
  }
}

async function createTablesIfNotExist(client) {
  try {
    // Таблица пользователей
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        avatar_url TEXT,
        role VARCHAR(20) DEFAULT 'user',
        telegram_chat_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица ресторанов
    await client.query(`
      CREATE TABLE IF NOT EXISTS restaurants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        image_url TEXT,
        rating DECIMAL(3,2) DEFAULT 0.0,
        delivery_time VARCHAR(50),
        delivery_price VARCHAR(50),
        categories TEXT[],
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица блюд
    await client.query(`
      CREATE TABLE IF NOT EXISTS dishes (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        image_url TEXT,
        price DECIMAL(10,2) NOT NULL,
        ingredients TEXT[],
        preparation_time INTEGER,
        is_vegetarian BOOLEAN DEFAULT false,
        is_spicy BOOLEAN DEFAULT false,
        is_available BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Таблицы созданы/проверены');

  } catch (error) {
    console.error(`❌ Ошибка создания таблиц: ${error.message}`);
  }
}

// ===== API ЭНДПОИНТЫ =====

// Health check для Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Главная страница
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Food Delivery API работает на Railway!',
    status: 'ok',
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    endpoints: {
      health: '/health',
      register: '/api/auth/register (POST)',
      login: '/api/auth/login (POST)',
      restaurants: '/api/restaurants (GET)',
      admin: '/api/admin/* (требуется токен)'
    }
  });
});

// Регистрация (упрощенная версия)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Заполните все обязательные поля'
      });
    }

    if (isDatabaseConnected && pool) {
      // Хешируем пароль
      const passwordHash = await bcrypt.hash(password, 10);

      // Проверяем существующего пользователя
      const existingUser = await pool.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
      );

      if (existingUser.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Пользователь с таким email уже существует'
        });
      }

      // Создаем пользователя
      const newUser = await pool.query(
          `INSERT INTO users (name, email, password_hash, phone)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, phone, avatar_url, role, created_at`,
          [name, email, passwordHash, phone || null]
      );

      const user = newUser.rows[0];
      const token = jwt.sign(
          { id: user.id, email: user.email, role: user.role },
          JWT_SECRET,
          { expiresIn: '7d' }
      );

      res.json({
        success: true,
        access_token: token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          avatarUrl: user.avatar_url
        }
      });

    } else {
      // Мок-режим
      res.json({
        success: true,
        message: 'Регистрация успешна (тестовый режим)',
        access_token: 'mock_token_' + Date.now(),
        user: {
          id: Date.now(),
          name,
          email,
          phone: phone || null,
          avatarUrl: null,
          createdAt: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение ресторанов (публичный API)
app.get('/api/restaurants', async (req, res) => {
  try {
    if (isDatabaseConnected && pool) {
      const result = await pool.query(
          `SELECT id, name, description, image_url, rating,
                delivery_time, delivery_price, categories
         FROM restaurants 
         WHERE is_active = true
         ORDER BY rating DESC`
      );
      res.json(result.rows);
    } else {
      // Мок-данные для тестирования
      res.json([
        {
          id: 1,
          name: 'Пицца Мания',
          description: 'Итальянская кухня, пицца, паста',
          image_url: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400',
          rating: 4.7,
          delivery_time: '25-35 мин',
          delivery_price: 'Бесплатно',
          categories: ['Пицца', 'Итальянская', 'Паста']
        },
        {
          id: 2,
          name: 'Бургер Кинг',
          description: 'Бургеры, картофель фри, напитки',
          image_url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400',
          rating: 4.5,
          delivery_time: '20-30 мин',
          delivery_price: '99 ₽',
          categories: ['Бургеры', 'Фастфуд']
        }
      ]);
    }
  } catch (error) {
    console.error('Ошибка получения ресторанов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API для Telegram бота (использует API ключ)
app.post('/api/bot/dish/:id/toggle', async (req, res) => {
  try {
    const apiKey = req.headers['x-admin-api-key'];

    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Неверный API ключ' });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({ error: 'База данных недоступна' });
    }

    const result = await pool.query(
        `UPDATE dishes 
       SET is_available = NOT is_available
       WHERE id = $1
       RETURNING id, name, is_available`,
        [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Блюдо не найдено' });
    }

    res.json({
      success: true,
      dish: result.rows[0],
      message: `Блюдо "${result.rows[0].name}" теперь ${result.rows[0].is_available ? 'доступно' : 'недоступно'}`
    });

  } catch (error) {
    console.error('Ошибка обновления блюда:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====

async function startServer() {
  try {
    // Инициализируем базу данных
    await initializeDatabase();

    // Запускаем сервер
    app.listen(PORT, () => {
      console.log(`\n🚀 Сервер запущен на Railway!`);
      console.log(`📡 Порт: ${PORT}`);
      console.log(`🔐 JWT секрет: ${JWT_SECRET ? 'Установлен' : 'Используется дефолтный'}`);
      console.log(`🌐 Режим базы: ${isDatabaseConnected ? '✅ Подключена' : '⚠️ Мок-режим'}`);
      console.log(`🔧 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

      // Показываем Railway URL если доступен
      if (process.env.RAILWAY_STATIC_URL) {
        console.log(`🌍 Railway URL: ${process.env.RAILWAY_STATIC_URL}`);
      } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        console.log(`🌍 Public Domain: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
      }
    });

  } catch (error) {
    console.error(`❌ Критическая ошибка запуска: ${error.message}`);
    process.exit(1);
  }
}

startServer();
