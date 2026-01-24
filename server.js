const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-API-Key', 'x-user-id']
}));
app.use(express.json());

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let pool;
let isDatabaseConnected = false;

// Функция отправки уведомления в Telegram
async function sendTelegramNotification(orderDetails) {
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      console.log('⚠️ Telegram bot token not configured');
      return null;
    }

    // Рассчитываем общую сумму и количество товаров
    let totalAmount = 0;
    let itemCount = 0;
    
    if (orderDetails.items && Array.isArray(orderDetails.items)) {
      orderDetails.items.forEach(item => {
        const price = parseFloat(item.dish_price) || parseFloat(item.price) || 0;
        const quantity = parseInt(item.quantity) || 1;
        totalAmount += price * quantity;
        itemCount += quantity;
      });
    }

    // Используем переданные значения или рассчитываем
    const finalTotalAmount = orderDetails.totalAmount || totalAmount;
    const finalItemCount = orderDetails.itemCount || itemCount;

    const message = `
🆕 НОВЫЙ ЗАКАЗ #${orderDetails.id}
👤 Клиент: ${orderDetails.customerName}
📞 Телефон: ${orderDetails.customerPhone}
📍 Адрес: ${orderDetails.deliveryAddress}
🍽️ Ресторан: ${orderDetails.restaurantName}
💰 Сумма: ${finalTotalAmount} ₽
📦 Товаров: ${finalItemCount} шт.
🕐 Время: ${new Date().toLocaleString('ru-RU')}

Состав заказа:
${orderDetails.items.map(item => {
  const price = parseFloat(item.dish_price) || parseFloat(item.price) || 0;
  const quantity = parseInt(item.quantity) || 1;
  const itemTotal = price * quantity;
  return `• ${item.dishName} x${quantity} - ${itemTotal} ₽`;
}).join('\n')}
  `; 

    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      },
      { timeout: 10000 }
    );

    console.log('✅ Telegram notification sent successfully');
    return response.data;
  } catch (error) {
    console.error('❌ Error sending Telegram notification:', error.message);
    // Не бросаем ошибку, чтобы не ломать создание заказа
    return null;
  }
}

async function initializeDatabase() {
  try {
    const databaseUrl = process.env.DATABASE_URL || 
                       (process.env.PGHOST ? 
                         `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE}` : 
                         null);

    log(`🔍 Проверяем подключение к БД...`);
    
    if (!databaseUrl) {
      log('⚠️ Не найдены данные для подключения к БД. Используем мок-режим.');
      return;
    }

    log('🔗 Пытаемся подключиться к PostgreSQL...');

    pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
      } : false,
      max: 5,
      min: 1,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      maxUses: 7500
    });

    log('🧪 Тестируем подключение...');
    const client = await pool.connect();
    
    const versionResult = await client.query('SELECT version()');
    log(`✅ PostgreSQL подключен! Версия: ${versionResult.rows[0].version.split(' ')[1]}`);
    
    await createOrUpdateTables(client);
    
    client.release();
    isDatabaseConnected = true;
    
    setInterval(async () => {
      try {
        await pool.query('SELECT 1');
      } catch (err) {
        log(`⚠️ Потеряно соединение с БД: ${err.message}`);
        isDatabaseConnected = false;
      }
    }, 30000);

  } catch (error) {
    log(`❌ Критическая ошибка подключения к PostgreSQL: ${error.message}`);
    log('📝 Приложение будет работать в мок-режиме без базы данных');
    isDatabaseConnected = false;
  }
}

app.get('/debug/db', async (req, res) => {
  try {
    const dbInfo = {
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      hasPgVariables: !!(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE),
      nodeEnv: process.env.NODE_ENV,
      isConnected: isDatabaseConnected,
      connectionStringPreview: process.env.DATABASE_URL ? 
        process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@') : 'не установлен'
    };

    if (isDatabaseConnected && pool) {
      try {
        const result = await pool.query('SELECT current_database() as db, current_user as user, version() as version');
        dbInfo.database = result.rows[0].db;
        dbInfo.user = result.rows[0].user;
        dbInfo.version = result.rows[0].version.split(' ')[1];
      } catch (err) {
        dbInfo.queryError = err.message;
      }
    }

    res.json(dbInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function createOrUpdateTables(client) {
  try {
    // Таблица пользователей
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        avatar_url TEXT,
        role VARCHAR(20) DEFAULT 'user',
        telegram_chat_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_verified BOOLEAN DEFAULT false 
      )
    `);
    log('✅ Таблица users создана/проверена');

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
    log('✅ Таблица restaurants создана/проверена');

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
    log('✅ Таблица dishes создана/проверена');

    // Таблица заказов
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        restaurant_id INTEGER REFERENCES restaurants(id),
        restaurant_name VARCHAR(100),
        restaurant_image TEXT,
        total_amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        delivery_address TEXT NOT NULL,
        payment_method VARCHAR(50),
        order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    log('✅ Таблица orders создана/проверена');

    // Таблица элементов заказа
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        dish_id INTEGER REFERENCES dishes(id),
        dish_name VARCHAR(100),
        dish_price DECIMAL(10,2),
        quantity INTEGER DEFAULT 1,
        dish_image TEXT
      )
    `);
    log('✅ Таблица order_items создана/проверена');

    // Таблица токенов для восстановления пароля
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    log('✅ Таблица password_reset_tokens создана/проверена');

    // Таблица избранного
    await client.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        restaurant_id INTEGER REFERENCES restaurants(id),
        dish_id INTEGER REFERENCES dishes(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, restaurant_id, dish_id)
      )
    `);
    log('✅ Таблица favorites создана/проверена');

     await addMissingColumns(client);

    await addTestDataIfNeeded(client);
    
  } catch (error) {
    log(`❌ Ошибка создания таблиц: ${error.message}`);
    throw error;
  }
}

// Новая функция для добавления недостающих колонок
async function addMissingColumns(client) {
  try {
    log('🔍 Проверяем наличие колонок...');
    
    // Проверяем и добавляем колонки в orders если их нет
    const ordersColumns = ['customer_name', 'customer_phone'];
    for (const column of ordersColumns) {
      const check = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'orders' AND column_name = $1
      `, [column]);
      
      if (check.rows.length === 0) {
        const type = column === 'customer_phone' ? 'VARCHAR(20)' : 'VARCHAR(100)';
        await client.query(`ALTER TABLE orders ADD COLUMN ${column} ${type}`);
        log(`✅ Добавлена колонка ${column} в orders`);
      }
    }
    
    // Проверяем и добавляем колонку dish_image в order_items если ее нет
    const checkDishImage = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'order_items' AND column_name = 'dish_image'
    `);
    
    if (checkDishImage.rows.length === 0) {
      await client.query(`ALTER TABLE order_items ADD COLUMN dish_image TEXT`);
      log('✅ Добавлена колонка dish_image в order_items');
    }
    
    log('✅ Проверка колонок завершена');
  } catch (error) {
    log(`⚠️ Ошибка при добавлении колонок: ${error.message}`);
    // Не прерываем выполнение если не удалось добавить колонки
  }
}

async function addTestDataIfNeeded(client) {
  try {
    const restaurantsCount = await client.query('SELECT COUNT(*) FROM restaurants');
    
    if (parseInt(restaurantsCount.rows[0].count) === 0) {
      log('🌱 Добавляем тестовые данные...');
      
      // Добавляем ресторан "Наетый кабан"
      await client.query(`
        INSERT INTO restaurants (name, description, image_url, rating, delivery_time, delivery_price, categories, is_active) 
        VALUES 
        ('Наетый кабан', 'Мясной ресторан с блюдами на огне. Стейки, ребрышки, бургеры и много мяса!', 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop', 4.9, '30-45 мин', 'Бесплатно от 1000 ₽', ARRAY['Мясо', 'Стейки', 'Бургеры', 'Ребрышки', 'Гриль'], true)
      `);
      
      // Добавляем блюда для "Наетого кабана"
      await client.query(`
        INSERT INTO dishes (restaurant_id, name, description, image_url, price, ingredients, preparation_time, is_vegetarian, is_spicy, is_available) 
        VALUES 
        (1, 'Стейк Рибай', 'Сочный стейк из мраморной говядины, прожарка на выбор', 'https://images.unsplash.com/photo-1600891964092-4316c288032e?w=400', 1899.00, ARRAY['Говядина', 'Соль', 'Перец', 'Травы'], 25, false, false, true),
        (1, 'Ребрышки BBQ', 'Свиные ребрышки в медово-сливочном соусе', 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400', 1299.00, ARRAY['Свиные ребра', 'Соус BBQ', 'Мёд', 'Специи'], 30, false, true, true),
        (1, 'Бургер «Кабан»', 'Бургер с говяжьей котлетой, беконом и сыром чеддер', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400', 799.00, ARRAY['Булочка', 'Говядина', 'Бекон', 'Сыр', 'Соус'], 20, false, false, true),
        (1, 'Куриные крылышки', 'Хрустящие куриные крылышки с соусом на выбор', 'https://images.unsplash.com/photo-1567620832903-9fc6debc209f?w=400', 599.00, ARRAY['Куриные крылья', 'Соус', 'Специи'], 15, false, true, true),
        (1, 'Картофель по-деревенски', 'Запеченный картофель с травами и чесноком', 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400', 299.00, ARRAY['Картофель', 'Чеснок', 'Травы', 'Масло'], 15, true, false, true)
      `);
      
      // Добавляем тестового пользователя
      const hashedPassword = await bcrypt.hash('password123', 10);
      await client.query(`
        INSERT INTO users (name, email, password, phone, role) 
        VALUES ('Тестовый Пользователь', 'test@example.com', $1, '+7 (999) 123-45-67', 'user')
        ON CONFLICT (email) DO NOTHING
      `, [hashedPassword]);
      
      log('✅ Тестовые данные добавлены');
    }
  } catch (error) {
    log(`⚠️ Не удалось добавить тестовые данные: ${error.message}`);
  }
}

function getUserIdFromToken(req) {
  try {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    
    const token = authHeader.split(' ')[1];
    
    if (!token) {
      return null;
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.id;
  } catch (error) {
    log(`❌ Ошибка верификации токена: ${error.message}`);
    return null;
  }
}

function validateAdminApiKey(req) {
  const apiKey = req.headers['x-admin-api-key'];
  return apiKey === ADMIN_API_KEY;
}

// ==================== ОСНОВНЫЕ ЭНДПОИНТЫ ====================

app.get('/', (req, res) => {
  res.json({
    message: '🚀 Food Delivery API работает!',
    status: 'ok',
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    telegram: TELEGRAM_BOT_TOKEN ? 'configured' : 'not-configured',
    version: '1.0.0',
    endpoints: {
      auth: ['/register (POST)', '/login (POST)', '/verify-email (GET)', '/reset-password (POST)'],
      user: ['/users/me (GET)', '/users/me/stats (GET)', '/users/me/orders (GET)'],
      restaurants: ['/restaurants (GET)', '/restaurants/:id (GET)', '/restaurants/:id/menu (GET)'],
      orders: ['/orders (POST)', '/orders/:id (GET)'],
      admin: ['/admin/* (требует X-Admin-API-Key)'],
      telegram: ['/test-notification (POST)']
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    telegram: TELEGRAM_BOT_TOKEN ? 'configured' : 'not-configured',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Регистрация пользователя
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    log(`📝 Регистрация: ${name} (${email})`);

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Заполните все обязательные поля'
      });
    }

    if (isDatabaseConnected && pool) {
      try {
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

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = await pool.query(
          `INSERT INTO users (name, email, password, phone, email_verified)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, email, phone, avatar_url, email_verified, created_at`,
          [name, email, hashedPassword, phone || null, false]
        );

        const user = newUser.rows[0];

        const token = jwt.sign(
          { id: user.id, email: user.email },
          JWT_SECRET,
          { expiresIn: '7d' }
        );

        res.json({
          success: true,
          message: 'Регистрация успешна',
          access_token: token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            avatarUrl: user.avatar_url,
            isEmailVerified: user.email_verified,
            createdAt: user.created_at
          }
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при регистрации: ${dbError.message}`);
        return sendMockRegistration(res, name, email, phone);
      }
    } else {
      sendMockRegistration(res, name, email, phone);
    }

  } catch (error) {
    log(`❌ Ошибка регистрации: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// Вход пользователя
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    log(`🔐 Вход: ${email}`);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Введите email и пароль'
      });
    }

    if (isDatabaseConnected && pool) {
      try {
        const userResult = await pool.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );

        if (userResult.rows.length === 0) {
          return res.status(401).json({
            success: false,
            error: 'Неверный email или пароль'
          });
        }

        const user = userResult.rows[0];
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
          return res.status(401).json({
            success: false,
            error: 'Неверный email или пароль'
          });
        }

        const token = jwt.sign(
          { id: user.id, email: user.email, role: user.role },
          JWT_SECRET,
          { expiresIn: '7d' }
        );

        res.json({
          success: true,
          message: 'Вход выполнен успешно',
          access_token: token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            avatarUrl: user.avatar_url,
            role: user.role,
            isEmailVerified: user.email_verified,
            createdAt: user.created_at
          }
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при входе: ${dbError.message}`);
        return sendMockLogin(res, email);
      }
    } else {
      sendMockLogin(res, email);
    }

  } catch (error) {
    log(`❌ Ошибка входа: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

function sendMockRegistration(res, name, email, phone) {
  const mockToken = jwt.sign(
    { id: Date.now(), email: email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({
    success: true,
    message: 'Регистрация успешна (тестовый режим)',
    access_token: mockToken,
    user: {
      id: Date.now(),
      name,
      email,
      phone: phone || null,
      avatarUrl: null,
      isEmailVerified: false,
      createdAt: new Date().toISOString()
    }
  });
}

function sendMockLogin(res, email) {
  const mockToken = jwt.sign(
    { id: 1, email: email, role: 'user' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({
    success: true,
    message: 'Вход выполнен успешно (тестовый режим)',
    access_token: mockToken,
    user: {
      id: 1,
      name: 'Иван Иванов',
      email: email,
      phone: '+7 (999) 123-45-67',
      avatarUrl: null,
      role: 'user',
      isEmailVerified: true,
      createdAt: new Date().toISOString()
    }
  });
}

// Получение информации о текущем пользователе
app.get('/users/me', async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    
    if (!userId) {
      return res.status(401).json({
        error: 'Требуется авторизация'
      });
    }

    if (isDatabaseConnected && pool) {
      try {
        const userResult = await pool.query(
          'SELECT id, name, email, phone, avatar_url, role, email_verified, created_at FROM users WHERE id = $1',
          [userId]
        );

        if (userResult.rows.length === 0) {
          return res.status(404).json({
            error: 'Пользователь не найден'
          });
        }

        const user = userResult.rows[0];

        res.json({
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          avatarUrl: user.avatar_url,
          role: user.role,
          isEmailVerified: user.email_verified,
          createdAt: user.created_at
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при получении пользователя: ${dbError.message}`);
        return res.status(500).json({
          error: 'Ошибка сервера'
        });
      }
    } else {
      res.json({
        id: userId,
        name: 'Иван Иванов',
        email: 'ivan@example.com',
        phone: '+7 (999) 123-45-67',
        avatarUrl: null,
        role: 'user',
        isEmailVerified: true,
        createdAt: new Date().toISOString()
      });
    }

  } catch (error) {
    log(`❌ Ошибка получения пользователя: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение статистики пользователя
app.get('/users/me/stats', async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    
    if (!userId) {
      return res.status(401).json({
        error: 'Требуется авторизация'
      });
    }

    log(`📊 Запрос статистики для пользователя ${userId}`);

    if (isDatabaseConnected && pool) {
      try {
        const totalOrdersResult = await pool.query(
          'SELECT COUNT(*) as count FROM orders WHERE user_id = $1',
          [userId]
        );
        
        const totalOrders = parseInt(totalOrdersResult.rows[0].count) || 0;

        const deliveredOrdersResult = await pool.query(
          'SELECT COUNT(*) as count FROM orders WHERE user_id = $1 AND status = $2',
          [userId, 'delivered']
        );
        
        const deliveredOrders = parseInt(deliveredOrdersResult.rows[0].count) || 0;

        const pendingOrdersResult = await pool.query(
          'SELECT COUNT(*) as count FROM orders WHERE user_id = $1 AND status = $2',
          [userId, 'pending']
        );
        
        const pendingOrders = parseInt(pendingOrdersResult.rows[0].count) || 0;

        const totalSpentResult = await pool.query(
          'SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE user_id = $1',
          [userId]
        );
        
        const totalSpent = parseFloat(totalSpentResult.rows[0].total) || 0;

        const averageOrderValue = totalOrders > 0 ? Math.round(totalSpent / totalOrders) : 0;

        const favoriteRestaurantResult = await pool.query(
          `SELECT restaurant_name, COUNT(*) as order_count 
           FROM orders 
           WHERE user_id = $1 
           GROUP BY restaurant_name 
           ORDER BY order_count DESC, restaurant_name 
           LIMIT 1`,
          [userId]
        );
        
        const favoriteRestaurant = favoriteRestaurantResult.rows.length > 0 
          ? favoriteRestaurantResult.rows[0].restaurant_name 
          : 'Нет данных';

        res.json({
          total_orders: totalOrders,
          delivered_orders: deliveredOrders,
          pending_orders: pendingOrders,
          total_spent: totalSpent,
          average_order_value: averageOrderValue,
          favorite_restaurant: favoriteRestaurant
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при получении статистики: ${dbError.message}`);
        return res.status(500).json({
          error: 'Ошибка сервера'
        });
      }
    } else {
      if (userId === 1) {
        res.json({
          total_orders: 5,
          delivered_orders: 4,
          pending_orders: 1,
          total_spent: 4500,
          average_order_value: 900,
          favorite_restaurant: 'Наетый кабан'
        });
      } else {
        res.json({
          total_orders: 0,
          delivered_orders: 0,
          pending_orders: 0,
          total_spent: 0,
          average_order_value: 0,
          favorite_restaurant: 'Нет данных'
        });
      }
    }

  } catch (error) {
    log(`❌ Ошибка получения статистики: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение истории заказов пользователя
app.get('/users/me/orders', async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    
    if (!userId) {
      return res.status(401).json({
        error: 'Требуется авторизация'
      });
    }

    log(`📦 Запрос истории заказов для пользователя ${userId}`);

    if (isDatabaseConnected && pool) {
      try {
        const ordersResult = await pool.query(
          `SELECT o.*, 
           COALESCE(
             json_agg(
               json_build_object(
                 'dish_id', oi.dish_id,
                 'dish_name', oi.dish_name,
                 'dish_description', d.description,
                 'dish_image', d.image_url,
                 'dish_price', oi.dish_price,
                 'quantity', oi.quantity
               )
             ) FILTER (WHERE oi.id IS NOT NULL),
             '[]'
           ) as items
           FROM orders o
           LEFT JOIN order_items oi ON o.id = oi.order_id
           LEFT JOIN dishes d ON oi.dish_id = d.id
           WHERE o.user_id = $1
           GROUP BY o.id
           ORDER BY o.order_date DESC
           LIMIT 50`,
          [userId]
        );

        const orders = ordersResult.rows.map(order => ({
          id: order.id.toString(),
          restaurant_name: order.restaurant_name || 'Ресторан',
          restaurant_image: order.restaurant_image || 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400',
          order_date: order.order_date.toISOString(),
          total_amount: parseFloat(order.total_amount),
          status: order.status || 'pending',
          delivery_address: order.delivery_address || 'Адрес не указан',
          payment_method: order.payment_method || 'Не указан',
          items: order.items || []
        }));

        res.json({ success: true, orders });

      } catch (dbError) {
        log(`❌ Ошибка базы при получении заказов: ${dbError.message}`);
        return res.json({ 
          success: true, 
          orders: [] 
        });
      }
    } else {
      if (userId === 1) {
        const mockOrders = [
          {
            id: '100',
            restaurant_name: 'Наетый кабан',
            restaurant_image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400',
            order_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            total_amount: 2598.00,
            status: 'delivered',
            delivery_address: 'ул. Ленина, д. 10, кв. 5',
            payment_method: 'Картой онлайн',
            items: [
              {
                dish_id: '1',
                dish_name: 'Стейк Рибай',
                dish_description: 'Сочный стейк из мраморной говядины',
                dish_image: 'https://images.unsplash.com/photo-1600891964092-4316c288032e?w=400',
                dish_price: 1899.00,
                quantity: 1
              },
              {
                dish_id: '5',
                dish_name: 'Картофель по-деревенски',
                dish_description: 'Запеченный картофель с травами и чесноком',
                dish_image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400',
                dish_price: 299.00,
                quantity: 1
              }
            ]
          }
        ];
        
        res.json({ success: true, orders: mockOrders });
      } else {
        res.json({ success: true, orders: [] });
      }
    }

  } catch (error) {
    log(`❌ Ошибка получения заказов: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка сервера' 
    });
  }
});

// Эндпоинт для получения заказов (для Telegram бота)
app.get('/bot/orders', async (req, res) => {
  try {
    // Проверяем API ключ администратора
    const apiKey = req.headers['x-admin-api-key'];
    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Неверный API ключ'
      });
    }

    log('🤖 Telegram bot запрашивает заказы');

    if (isDatabaseConnected && pool) {
      try {
        // Получаем все заказы (без фильтрации по пользователю)
        const ordersResult = await pool.query(
          `SELECT 
            o.id,
            o.restaurant_name,
            o.restaurant_image,
            o.total_amount,
            o.status,
            o.delivery_address,
            o.payment_method,
            o.order_date,
            o.customer_name,
            o.customer_phone,
            COALESCE(
              json_agg(
                json_build_object(
                  'dish_id', oi.dish_id,
                  'dish_name', oi.dish_name,
                  'dish_price', oi.dish_price,
                  'quantity', oi.quantity,
                  'dish_image', oi.dish_image
                )
              ) FILTER (WHERE oi.id IS NOT NULL),
              '[]'
            ) as items
           FROM orders o
           LEFT JOIN order_items oi ON o.id = oi.order_id
           GROUP BY o.id
           ORDER BY o.order_date DESC
           LIMIT 50`
        );

        const orders = ordersResult.rows.map(order => ({
          id: order.id.toString(),
          restaurant_name: order.restaurant_name || 'Ресторан',
          restaurant_image: order.restaurant_image || '',
          order_date: order.order_date.toISOString(),
          total_amount: parseFloat(order.total_amount),
          status: order.status || 'pending',
          delivery_address: order.delivery_address || 'Адрес не указан',
          payment_method: order.payment_method || 'Не указан',
          customer_name: order.customer_name || 'Клиент',
          customer_phone: order.customer_phone || 'Телефон не указан',
          items: order.items || []
        }));

        res.json({ 
          success: true, 
          orders: orders 
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при получении заказов для бота: ${dbError.message}`);
        res.status(500).json({ 
          success: false, 
          error: 'Ошибка базы данных' 
        });
      }
    } else {
      // Мок-данные для тестирования
      const mockOrders = [
        {
          id: '100',
          restaurant_name: 'Наетый кабан',
          restaurant_image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400',
          order_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          total_amount: 2598.00,
          status: 'pending',
          delivery_address: 'ул. Ленина, д. 10, кв. 5',
          payment_method: 'Картой онлайн',
          customer_name: 'Иван Иванов',
          customer_phone: '+7 (999) 123-45-67',
          items: [
            {
              dish_id: '1',
              dish_name: 'Стейк Рибай',
              dish_price: 1899.00,
              quantity: 1
            },
            {
              dish_id: '5',
              dish_name: 'Картофель по-деревенски',
              dish_price: 299.00,
              quantity: 2
            }
          ]
        }
      ];
      
      res.json({ 
        success: true, 
        orders: mockOrders,
        mode: 'mock'
      });
    }

  } catch (error) {
    log(`❌ Ошибка получения заказов для бота: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка сервера' 
    });
  }
});

// Эндпоинт для обновления статуса заказа (для Telegram бота)
app.put('/bot/orders/:id/status', async (req, res) => {
  try {
    // Проверяем API ключ администратора
    const apiKey = req.headers['x-admin-api-key'];
    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Неверный API ключ'
      });
    }

    const orderId = req.params.id;
    const { status } = req.body;

    log(`🤖 Telegram bot обновляет статус заказа ${orderId} на ${status}`);

    const validStatuses = ['pending', 'preparing', 'delivering', 'delivered', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Неверный статус. Допустимые значения: ${validStatuses.join(', ')}`
      });
    }

    if (isDatabaseConnected && pool) {
      try {
        const result = await pool.query(
          `UPDATE orders SET status = $1 WHERE id = $2 RETURNING *`,
          [status, orderId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ 
            success: false,
            error: 'Заказ не найден' 
          });
        }

        const order = result.rows[0];

        // Отправляем уведомление в телеграм пользователю, если у него есть chat_id
        if (order.user_id) {
          try {
            const userResult = await pool.query(
              'SELECT telegram_chat_id FROM users WHERE id = $1',
              [order.user_id]
            );
            
            if (userResult.rows.length > 0 && userResult.rows[0].telegram_chat_id) {
              const chatId = userResult.rows[0].telegram_chat_id;
              const statusText = {
                'pending': 'принят в обработку',
                'preparing': 'начали готовить',
                'delivering': 'отправлен курьером',
                'delivered': 'доставлен',
                'cancelled': 'отменен'
              }[status] || 'обновлен';
              
              const message = 
                `🔄 Статус вашего заказа #${order.id} изменен:\n` +
                `Статус: ${statusText}\n` +
                `Время: ${new Date().toLocaleString('ru-RU')}`;
              
              await axios.post(
                `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                {
                  chat_id: chatId,
                  text: message
                },
                { timeout: 5000 }
              );
              
              log(`✅ Уведомление отправлено пользователю ${chatId}`);
            }
          } catch (telegramError) {
            log(`⚠️ Ошибка отправки уведомления пользователю: ${telegramError.message}`);
          }
        }

        res.json({
          success: true,
          message: `Статус заказа обновлен на "${status}"`,
          order: {
            id: order.id,
            status: order.status,
            updated_at: order.updated_at || new Date().toISOString()
          }
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при обновлении статуса: ${dbError.message}`);
        res.status(500).json({ 
          success: false,
          error: 'Ошибка базы данных' 
        });
      }
    } else {
      // Мок-режим
      res.json({
        success: true,
        message: `Статус заказа обновлен на "${status}" (тестовый режим)`,
        order: {
          id: orderId,
          status: status,
          updated_at: new Date().toISOString(),
          mode: 'mock'
        }
      });
    }

  } catch (error) {
    log(`❌ Ошибка обновления статуса заказа: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера' 
    });
  }
});

// Эндпоинт для получения конкретного заказа (для Telegram бота)
app.get('/bot/orders/:id', async (req, res) => {
  try {
    // Проверяем API ключ администратора
    const apiKey = req.headers['x-admin-api-key'];
    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Неверный API ключ'
      });
    }

    const orderId = req.params.id;
    log(`🤖 Telegram bot запрашивает заказ ${orderId}`);

    if (isDatabaseConnected && pool) {
      try {
        const result = await pool.query(
          `SELECT 
            o.*,
            COALESCE(
              json_agg(
                json_build_object(
                  'dish_id', oi.dish_id,
                  'dish_name', oi.dish_name,
                  'dish_price', oi.dish_price,
                  'quantity', oi.quantity,
                  'dish_image', oi.dish_image
                )
              ) FILTER (WHERE oi.id IS NOT NULL),
              '[]'
            ) as items
           FROM orders o
           LEFT JOIN order_items oi ON o.id = oi.order_id
           WHERE o.id = $1
           GROUP BY o.id`,
          [orderId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ 
            success: false,
            error: 'Заказ не найден' 
          });
        }

        const order = result.rows[0];
        
        const formattedOrder = {
          id: order.id.toString(),
          restaurant_name: order.restaurant_name || 'Ресторан',
          restaurant_image: order.restaurant_image || '',
          order_date: order.order_date.toISOString(),
          total_amount: parseFloat(order.total_amount),
          status: order.status || 'pending',
          delivery_address: order.delivery_address || 'Адрес не указан',
          payment_method: order.payment_method || 'Не указан',
          customer_name: order.customer_name || 'Клиент',
          customer_phone: order.customer_phone || 'Телефон не указан',
          items: order.items || []
        };

        res.json({
          success: true,
          order: formattedOrder
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при получении заказа: ${dbError.message}`);
        res.status(500).json({ 
          success: false,
          error: 'Ошибка базы данных' 
        });
      }
    } else {
      // Мок-данные
      const mockOrder = {
        id: orderId,
        restaurant_name: 'Наетый кабан',
        restaurant_image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400',
        order_date: new Date().toISOString(),
        total_amount: 2598.00,
        status: 'pending',
        delivery_address: 'ул. Ленина, д. 10, кв. 5',
        payment_method: 'Картой онлайн',
        customer_name: 'Иван Иванов',
        customer_phone: '+7 (999) 123-45-67',
        items: [
          {
            dish_id: '1',
            dish_name: 'Стейк Рибай',
            dish_price: 1899.00,
            quantity: 1
          },
          {
            dish_id: '5',
            dish_name: 'Картофель по-деревенски',
            dish_price: 299.00,
            quantity: 2
          }
        ],
        mode: 'mock'
      };
      
      res.json({
        success: true,
        order: mockOrder
      });
    }

  } catch (error) {
    log(`❌ Ошибка получения заказа: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера' 
    });
  }
});

// Получение списка ресторанов
app.get('/restaurants', async (req, res) => {
  try {
    log('🍽️ Запрос списка ресторанов');

    if (isDatabaseConnected && pool) {
      const result = await pool.query(
        `SELECT id, name, description, image_url, rating,
                delivery_time, delivery_price, categories
         FROM restaurants 
         WHERE is_active = true
         ORDER BY rating DESC, name`
      );
      
      res.json(result.rows);
      
    } else {
      res.json([
        {
          id: 1,
          name: 'Наетый кабан',
          description: 'Мясной ресторан с блюдами на огне. Стейки, ребрышки, бургеры и много мяса!',
          image_url: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop',
          rating: 4.9,
          delivery_time: '30-45 мин',
          delivery_price: 'Бесплатно от 1000 ₽',
          categories: ['Мясо', 'Стейки', 'Бургеры', 'Ребрышки', 'Гриль']
        }
      ]);
    }

  } catch (error) {
    log(`❌ Ошибка получения ресторанов: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение меню ресторана
app.get('/restaurants/:id/menu', async (req, res) => {
  try {
    const restaurantId = req.params.id;
    log(`📋 Запрос меню для ресторана ${restaurantId}`);

    if (isDatabaseConnected && pool) {
      const result = await pool.query(
        `SELECT id, name, description, image_url, price,
                ingredients, preparation_time, 
                is_vegetarian, is_spicy
         FROM dishes 
         WHERE restaurant_id = $1 AND is_available = true
         ORDER BY name`,
        [restaurantId]
      );
      
      res.json(result.rows);
      
    } else {
      res.json([
        {
          id: 1,
          name: 'Стейк Рибай',
          description: 'Сочный стейк из мраморной говядины, прожарка на выбор',
          image_url: 'https://images.unsplash.com/photo-1600891964092-4316c288032e?w=400',
          price: 1899.00,
          ingredients: ['Говядина', 'Соль', 'Перец', 'Травы'],
          preparation_time: 25,
          is_vegetarian: false,
          is_spicy: false
        },
        {
          id: 2,
          name: 'Ребрышки BBQ',
          description: 'Свиные ребрышки в медово-сливочном соусе',
          image_url: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400',
          price: 1299.00,
          ingredients: ['Свиные ребра', 'Соус BBQ', 'Мёд', 'Специи'],
          preparation_time: 30,
          is_vegetarian: false,
          is_spicy: true
        }
      ]);
    }

  } catch (error) {
    log(`❌ Ошибка получения меню: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание заказа
app.post('/orders', async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Требуется авторизация'
      });
    }

    const {
      restaurant_id,
      items,
      delivery_address,
      payment_method,
      restaurant_name,
      restaurant_image,
      customer_name,
      customer_phone
    } = req.body;

    log(`🛒 Создание заказа для пользователя ${userId}`);

    // Валидация
    if (!restaurant_id || !items || !delivery_address) {
      return res.status(400).json({
        success: false,
        error: 'Заполните обязательные поля: restaurant_id, items, delivery_address'
      });
    }

    if (isDatabaseConnected && pool) {
      try {
        // Рассчитываем общую сумму
          let totalAmount = 0;
          const orderItems = [];
          
          console.log('📋 Полученные товары:', JSON.stringify(items, null, 2));
          
          for (const item of items) {
            // Отладочный вывод
            console.log('🍴 Обрабатываю товар:', {
              dish_name: item.dish_name,
              price: item.price,
              dish_price: item.dish_price,
              quantity: item.quantity
            });
            
            const price = parseFloat(item.dish_price) || 
                          parseFloat(item.price) || 
                          parseFloat(item.dishPrice) || // Добавьте все возможные варианты
                          0;
            
            const quantity = parseInt(item.quantity) || 1;
            const itemTotal = price * quantity;
            totalAmount += itemTotal;
            
            console.log(`💰 Рассчитано: Цена=${price}, Кол-во=${quantity}, Итого=${itemTotal}, Общая=${totalAmount}`);
            
            orderItems.push({
              dish_id: item.dish_id,
              dish_name: item.dish_name || item.name || 'Блюдо',
              dish_price: price,
              quantity: quantity,
              dish_image: item.dish_image || item.imageUrl || ''
            });
          }

        // Создаем заказ
        const orderResult = await pool.query(
          `INSERT INTO orders (
            user_id, restaurant_id, restaurant_name, restaurant_image,
            total_amount, status, delivery_address, payment_method,
            customer_name, customer_phone
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *`,
          [
            userId,
            restaurant_id,
            restaurant_name || 'Ресторан',
            restaurant_image || '',
            totalAmount,
            'pending',
            delivery_address,
            payment_method || 'Картой онлайн',
            customer_name || 'Клиент',  
            customer_phone || 'Не указан'
          ]
        );

        const order = orderResult.rows[0];

        // Добавляем элементы заказа
        for (const item of orderItems) {
          await pool.query(
            `INSERT INTO order_items (
              order_id, dish_id, dish_name, dish_price, quantity, dish_image
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              order.id,
              item.dish_id,
              item.dish_name,
              item.dish_price,
              item.quantity,
              item.dish_image
            ]
          );
        }

        // Получаем полную информацию о заказе
        const fullOrderResult = await pool.query(
          `SELECT o.*, 
           COALESCE(
             json_agg(
               json_build_object(
                 'dish_id', oi.dish_id,
                 'dish_name', oi.dish_name,
                 'dish_price', oi.dish_price,
                 'quantity', oi.quantity,
                 'dish_image', oi.dish_image
               )
             ) FILTER (WHERE oi.id IS NOT NULL),
             '[]'
           ) as items
           FROM orders o
           LEFT JOIN order_items oi ON o.id = oi.order_id
           WHERE o.id = $1
           GROUP BY o.id`,
          [order.id]
        );

        const fullOrder = fullOrderResult.rows[0];

        // Отправляем уведомление в Telegram
        try {
          // Рассчитываем правильные значения для уведомления
          let notificationTotal = 0;
          let notificationItemCount = 0;
          
          items.forEach(item => {
            const price = parseFloat(item.dish_price) || parseFloat(item.price) || 0;
            const quantity = parseInt(item.quantity) || 1;
            notificationTotal += price * quantity;
            notificationItemCount += quantity;
          });
        
          const notificationData = {
            id: fullOrder.id,
            customerName: customer_name || 'Клиент',
            customerPhone: customer_phone || 'Не указан',
            deliveryAddress: delivery_address,
            restaurantName: restaurant_name || 'Ресторан',
            totalAmount: notificationTotal, // Используем рассчитанное значение
            itemCount: notificationItemCount, // Используем рассчитанное значение
            items: items.map(item => ({
              dishName: item.dish_name || item.name || 'Блюдо',
              quantity: item.quantity || 1,
              dish_price: parseFloat(item.dish_price) || parseFloat(item.price) || 0,
              price: parseFloat(item.dish_price) || parseFloat(item.price) || 0
            }))
          };
        
          console.log('📊 Данные для уведомления:', notificationData);
          await sendTelegramNotification(notificationData);
        } catch (telegramError) {
          log(`⚠️ Ошибка отправки уведомления в Telegram: ${telegramError.message}`);
        }

        res.json({
          success: true,
          message: 'Заказ успешно создан',
          order: {
            id: fullOrder.id.toString(),
            restaurant_name: fullOrder.restaurant_name,
            restaurant_image: fullOrder.restaurant_image,
            order_date: fullOrder.order_date.toISOString(),
            total_amount: parseFloat(fullOrder.total_amount),
            status: fullOrder.status,
            delivery_address: fullOrder.delivery_address,
            payment_method: fullOrder.payment_method,
            items: fullOrder.items || []
          }
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при создании заказа: ${dbError.message}`);
        res.status(500).json({
          success: false,
          error: 'Ошибка сервера при создании заказа'
        });
      }
    } else {
      // Мок-режим
      const mockOrder = {
        id: Date.now().toString(),
        restaurant_name: restaurant_name || 'Наетый кабан',
        restaurant_image: restaurant_image || 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400',
        order_date: new Date().toISOString(),
        total_amount: items.reduce((sum, item) => sum + (parseFloat(item.dish_price) || parseFloat(item.price) || 0) * (item.quantity || 1), 0),
        status: 'pending',
        delivery_address: delivery_address,
        payment_method: payment_method || 'Картой онлайн',
        items: items.map(item => ({
          dish_id: item.dish_id,
          dish_name: item.dish_name || item.name || 'Блюдо',
          dish_price: parseFloat(item.dish_price) || parseFloat(item.price) || 0,
          quantity: item.quantity || 1,
          dish_image: item.dish_image || item.imageUrl
        }))
      };

      // Отправляем уведомление в Telegram даже в мок-режиме
      try {
        const notificationData = {
          id: mockOrder.id,
          customerName: customer_name || 'Клиент',
          customerPhone: customer_phone || 'Не указан',
          deliveryAddress: delivery_address,
          restaurantName: restaurant_name || 'Наетый кабан',
          totalAmount: mockOrder.total_amount,
          itemCount: items.length,
          items: items.map(item => ({
            dishName: item.dish_name || item.name || 'Блюдо',
            quantity: item.quantity || 1,
            totalPrice: (parseFloat(item.dish_price) || parseFloat(item.price) || 0) * (item.quantity || 1)
          }))
        };

        await sendTelegramNotification(notificationData);
      } catch (telegramError) {
        log(`⚠️ Ошибка отправки уведомления в Telegram: ${telegramError.message}`);
      }

      res.json({
        success: true,
        message: 'Заказ создан (тестовый режим)',
        order: mockOrder
      });
    }

  } catch (error) {
    log(`❌ Ошибка создания заказа: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// Обновление существующего блюда
app.put('/admin/dishes/:id', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ 
        success: false,
        error: 'Неверный API ключ' 
      });
    }

    const dishId = req.params.id;
    const updates = req.body;

    // Валидация - хотя бы одно поле для обновления
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Нет данных для обновления' 
      });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({
        success: false,
        error: 'База данных недоступна'
      });
    }

    // Собираем поля для обновления
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (updates.name !== undefined) {
      updateFields.push(`name = $${paramCount++}`);
      updateValues.push(updates.name);
    }
    
    if (updates.description !== undefined) {
      updateFields.push(`description = $${paramCount++}`);
      updateValues.push(updates.description);
    }
    
    if (updates.image_url !== undefined) {
      updateFields.push(`image_url = $${paramCount++}`);
      updateValues.push(updates.image_url);
    }
    
    if (updates.price !== undefined) {
      // Парсим цену
      const parsedPrice = typeof updates.price === 'string' 
        ? parseFloat(updates.price.replace(',', '.')) 
        : parseFloat(updates.price);
      
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Цена должна быть положительным числом'
        });
      }
      
      updateFields.push(`price = $${paramCount++}`);
      updateValues.push(parsedPrice);
    }
    
    if (updates.preparation_time !== undefined) {
      updateFields.push(`preparation_time = $${paramCount++}`);
      updateValues.push(parseInt(updates.preparation_time) || 30);
    }
    
    if (updates.is_spicy !== undefined) {
      updateFields.push(`is_spicy = $${paramCount++}`);
      updateValues.push(Boolean(updates.is_spicy));
    }
    
    if (updates.is_vegetarian !== undefined) {
      updateFields.push(`is_vegetarian = $${paramCount++}`);
      updateValues.push(Boolean(updates.is_vegetarian));
    }
    
    if (updates.is_available !== undefined) {
      updateFields.push(`is_available = $${paramCount++}`);
      updateValues.push(Boolean(updates.is_available));
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Нет валидных полей для обновления' 
      });
    }

    updateValues.push(dishId);
    
    const query = `
      UPDATE dishes 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, updateValues);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Блюдо не найдено' 
      });
    }

    res.json({
      success: true,
      message: 'Блюдо успешно обновлено',
      dish: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Ошибка обновления блюда:', error);
    log(`❌ Ошибка обновления блюда: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера при обновлении блюда'
    });
  }
});

// Эндпоинт для тестирования уведомлений
app.post('/test-notification', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(400).json({
        success: false,
        error: 'Telegram bot token or chat ID not configured'
      });
    }

    const testOrder = {
      id: 'TEST_' + Date.now(),
      customerName: 'Тестовый Клиент',
      customerPhone: '+7 (999) 123-45-67',
      deliveryAddress: 'ул. Тестовая, д. 1',
      restaurantName: 'Наетый кабан',
      totalAmount: 2598,
      itemCount: 2,
      items: [
        { dishName: 'Стейк Рибай', quantity: 1, totalPrice: 1899 },
        { dishName: 'Картофель по-деревенски', quantity: 2, totalPrice: 698 }
      ]
    };

    await sendTelegramNotification(testOrder);
    res.json({ success: true, message: 'Тестовое уведомление отправлено' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Подтверждение email
app.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Токен не предоставлен'
      });
    }

    log(`📧 Подтверждение email с токеном: ${token}`);

    // В реальном приложении здесь была бы проверка токена
    // и обновление статуса в базе данных
    
    res.json({
      success: true,
      message: 'Email успешно подтвержден'
    });

  } catch (error) {
    log(`❌ Ошибка подтверждения email: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// Запрос на сброс пароля
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Введите email'
      });
    }

    log(`🔑 Запрос на сброс пароля для: ${email}`);

    // В реальном приложении здесь была бы отправка email с токеном
    
    res.json({
      success: true,
      message: 'Инструкции по восстановлению пароля отправлены на email'
    });

  } catch (error) {
    log(`❌ Ошибка запроса сброса пароля: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// Сброс пароля
app.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Токен и новый пароль обязательны'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Пароль должен содержать минимум 6 символов'
      });
    }

    log(`🔑 Сброс пароля с токеном: ${token}`);

    // В реальном приложении здесь была бы проверка токена
    // и обновление пароля в базе данных
    
    res.json({
      success: true,
      message: 'Пароль успешно изменен'
    });

  } catch (error) {
    log(`❌ Ошибка сброса пароля: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// Изменение пароля (требуется авторизация)
app.post('/change-password', async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Требуется авторизация'
      });
    }

    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Введите текущий и новый пароль'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Новый пароль должен содержать минимум 6 символов'
      });
    }

    log(`🔑 Изменение пароля для пользователя ${userId}`);

    if (isDatabaseConnected && pool) {
      try {
        // Получаем текущий пароль пользователя
        const userResult = await pool.query(
          'SELECT password FROM users WHERE id = $1',
          [userId]
        );

        if (userResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Пользователь не найден'
          });
        }

        const user = userResult.rows[0];
        
        // Проверяем текущий пароль
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        
        if (!validPassword) {
          return res.status(401).json({
            success: false,
            error: 'Неверный текущий пароль'
          });
        }

        // Хэшируем новый пароль
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Обновляем пароль
        await pool.query(
          'UPDATE users SET password = $1 WHERE id = $2',
          [hashedPassword, userId]
        );

        res.json({
          success: true,
          message: 'Пароль успешно изменен'
        });

      } catch (dbError) {
        log(`❌ Ошибка базы при изменении пароля: ${dbError.message}`);
        res.status(500).json({
          success: false,
          error: 'Ошибка сервера'
        });
      }
    } else {
      res.json({
        success: true,
        message: 'Пароль изменен (тестовый режим)'
      });
    }

  } catch (error) {
    log(`❌ Ошибка изменения пароля: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// ==================== АДМИН ЭНДПОИНТЫ ====================

// Переключение доступности блюда (для Telegram бота)
app.post('/bot/dish/:id/toggle', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ 
        success: false,
        error: 'Неверный API ключ'
      });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({ 
        success: false,
        error: 'База данных недоступна',
        mode: 'mock'
      });
    }

    const dishId = req.params.id;
    log(`🔄 Переключение доступности блюда ${dishId}`);

    const result = await pool.query(
      `UPDATE dishes 
       SET is_available = NOT is_available
       WHERE id = $1
       RETURNING id, name, is_available`,
      [dishId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Блюдо не найдено'
      });
    }

    const dish = result.rows[0];
    const status = dish.is_available ? 'доступно' : 'недоступно';

    res.json({
      success: true,
      message: `Блюдо "${dish.name}" теперь ${status}`,
      dish: dish
    });

  } catch (error) {
    log(`❌ Ошибка переключения блюда: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера'
    });
  }
});

// Получение информации о блюде (для админов)
app.get('/bot/dish/:id', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ 
        success: false,
        error: 'Неверный API ключ' 
      });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({ 
        success: false,
        error: 'База данных недоступна' 
      });
    }

    const dishId = req.params.id;
    const result = await pool.query(
      `SELECT d.*, r.name as restaurant_name
       FROM dishes d
       JOIN restaurants r ON d.restaurant_id = r.id
       WHERE d.id = $1`,
      [dishId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Блюдо не найдено' 
      });
    }

    res.json({
      success: true,
      dish: result.rows[0]
    });

  } catch (error) {
    log(`❌ Ошибка получения блюда: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера' 
    });
  }
});

// Создание нового блюда
app.post('/admin/dishes', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ 
        success: false,
        error: 'Неверный API ключ' 
      });
    }

    const {
      restaurant_id,
      name,
      description,
      image_url,
      price: priceFromBody, // Изменяем имя переменной
      ingredients,
      preparation_time,
      is_vegetarian,
      is_spicy
    } = req.body;

    // Валидация
    if (!restaurant_id || !name || !priceFromBody) {
      return res.status(400).json({ 
        success: false,
        error: 'Заполните обязательные поля: restaurant_id, name, price' 
      });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({
        success: false,
        error: 'База данных недоступна',
        mode: 'mock'
      });
    }

    // Парсим цену (убедитесь, что это число)
    const parsedPrice = typeof priceFromBody === 'string' 
      ? parseFloat(priceFromBody.replace(',', '.')) 
      : parseFloat(priceFromBody);
    
    console.log('📊 Parsed price:', { 
      original: priceFromBody, 
      parsed: parsedPrice,
      type: typeof priceFromBody 
    });
    
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Цена должна быть положительным числом'
      });
    }
    
    const result = await pool.query(
      `INSERT INTO dishes (
        restaurant_id, name, description, image_url, price,
        ingredients, preparation_time, is_vegetarian, is_spicy, is_available
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        restaurant_id,
        name,
        description || '',
        image_url || '',
        parsedPrice, // Используем parsedPrice
        Array.isArray(ingredients) ? ingredients : (ingredients ? [ingredients] : []),
        preparation_time || 30,
        Boolean(is_vegetarian),
        Boolean(is_spicy),
        true
      ]
    );

    console.log('✅ Блюдо создано:', result.rows[0]);

    res.json({
      success: true,
      message: 'Блюдо успешно создано',
      dish: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Полная ошибка создания блюда:', error);
    log(`❌ Ошибка создания блюда: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Обновление статуса заказа
app.put('/admin/orders/:id/status', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ 
        success: false,
        error: 'Неверный API ключ' 
      });
    }

    const orderId = req.params.id;
    const { status } = req.body;

    const validStatuses = ['pending', 'preparing', 'delivering', 'delivered', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Неверный статус. Допустимые значения: ${validStatuses.join(', ')}`
      });
    }

    const result = await pool.query(
      `UPDATE orders SET status = $1 WHERE id = $2 RETURNING *`,
      [status, orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Заказ не найден' 
      });
    }

    res.json({
      success: true,
      message: `Статус заказа обновлен на "${status}"`,
      order: result.rows[0]
    });

  } catch (error) {
    log(`❌ Ошибка обновления статуса: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера' 
    });
  }
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
  try {
    await initializeDatabase();

    // ДОБАВЬТЕ ЭТУ ПРОВЕРКУ ПЕРЕД app.listen
    console.log('\n🔍 ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ:');
    console.log('='.repeat(50));
    console.log(`🤖 TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ УСТАНОВЛЕН' : '❌ НЕ УСТАНОВЛЕН'}`);
    console.log(`💬 TELEGRAM_CHAT_ID: ${process.env.TELEGRAM_CHAT_ID ? '✅ ' + process.env.TELEGRAM_CHAT_ID : '❌ НЕ УСТАНОВЛЕН'}`);
    console.log(`🔐 JWT_SECRET: ${process.env.JWT_SECRET ? '✅ УСТАНОВЛЕН' : '❌ НЕ УСТАНОВЛЕН'}`);
    console.log(`👑 ADMIN_API_KEY: ${process.env.ADMIN_API_KEY ? '✅ УСТАНОВЛЕН' : '❌ НЕ УСТАНОВЛЕН'}`);
    console.log(`🗄️ DATABASE_URL: ${process.env.DATABASE_URL ? '✅ УСТАНОВЛЕН' : '❌ НЕ УСТАНОВЛЕН'}`);
    console.log('='.repeat(50));
    
    // Если Telegram не настроен, показываем предупреждение
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      console.log('\n⚠️ ВНИМАНИЕ: Telegram не настроен!');
      console.log('   Для настройки добавьте в Railway Variables:');
      console.log('   1. TELEGRAM_BOT_TOKEN - получите у @BotFather');
      console.log(`   2. TELEGRAM_CHAT_ID = 8512592804 (ваш ID)`);
      console.log('   После добавления нажмите "Redeploy" в Railway');
    } else {
      console.log('\n✅ Telegram полностью настроен!');
      console.log(`   Уведомления будут отправляться в чат: ${process.env.TELEGRAM_CHAT_ID}`);
    }

    app.listen(PORT, () => {
      log(`\n🚀 Сервер запущен!`);
      log(`📡 Порт: ${PORT}`);
      log(`🌐 Режим базы: ${isDatabaseConnected ? '✅ Подключена' : '⚠️ Мок-режим'}`);
      // Обновите эту строку для более детального вывода
      const hasTelegramToken = !!process.env.TELEGRAM_BOT_TOKEN;
      const hasTelegramChatId = !!process.env.TELEGRAM_CHAT_ID;
      
      if (hasTelegramToken && hasTelegramChatId) {
        log(`🤖 Telegram: ✅ Настроен (chat ID: ${process.env.TELEGRAM_CHAT_ID})`);
      } else if (hasTelegramToken && !hasTelegramChatId) {
        log(`🤖 Telegram: ⚠️ Частично настроен (нет TELEGRAM_CHAT_ID)`);
      } else if (!hasTelegramToken && hasTelegramChatId) {
        log(`🤖 Telegram: ⚠️ Частично настроен (нет TELEGRAM_BOT_TOKEN)`);
      } else {
        log(`🤖 Telegram: ❌ Не настроен`);
      }
      
      // ... остальной ваш код
    });

  } catch (error) {
    log(`❌ Критическая ошибка запуска: ${error.message}`);
    process.exit(1);
  }
}

// Эндпоинт для проверки конфигурации
app.get('/config-check', (req, res) => {
  res.json({
    telegram: {
      hasBotToken: !!process.env.TELEGRAM_BOT_TOKEN,
      hasChatId: !!process.env.TELEGRAM_CHAT_ID,
      chatId: process.env.TELEGRAM_CHAT_ID || null,
      status: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID 
        ? 'fully_configured' 
        : 'not_configured'
    },
    database: {
      connected: isDatabaseConnected,
      hasUrl: !!process.env.DATABASE_URL
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

process.on('uncaughtException', (error) => {
  console.error('🔥 Непойманное исключение:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Необработанный промис:', reason);
  console.error('Promise:', promise);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, завершаем работу...');
  if (pool) {
    pool.end(() => {
      console.log('✅ База данных отключена');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

startServer();
