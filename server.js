const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';

let pool;
let isDatabaseConnected = false;

async function initializeDatabase() {
  try {

    const databaseUrl = process.env.DATABASE_URL || 
                       (process.env.PGHOST ? 
                         `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE}` : 
                         null);

    log(`🔍 Проверяем подключение к БД...`);
    log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'присутствует' : 'отсутствует'}`);
    log(`   PGHOST: ${process.env.PGHOST || 'не установлен'}`);
    log(`   PGUSER: ${process.env.PGUSER || 'не установлен'}`);
    
    if (!databaseUrl) {
      log('⚠️ Не найдены данные для подключения к БД. Используем мок-режим.');
      log('💡 Подсказка: Добавьте PostgreSQL в Railway или установите DATABASE_URL');
      return;
    }

    log('🔗 Пытаемся подключиться к PostgreSQL...');
    

    pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false
      },
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
    log(`❌ Критическая ошибка подключения к PostgreSQL:`);
    log(`   Сообщение: ${error.message}`);
    log(`   Код: ${error.code}`);
    log(`   Детали: ${error.stack}`);
    
    if (error.code === 'ECONNREFUSED') {
      log('💡 Подсказка: Проверьте, что PostgreSQL запущен в Railway');
    } else if (error.code === '28P01') {
      log('💡 Подсказка: Неверный логин/пароль для БД');
    } else if (error.message.includes('does not exist')) {
      log('💡 Подсказка: База данных не существует. Создайте ее в Railway');
    }
    
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    log('✅ Таблица users создана/проверена');

    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT \'user\'');
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT');
    } catch (e) {
    }

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
        is_active BOOLEAN DEFAULT true,  // ДОБАВЛЕНО ДЛЯ ФИЛЬТРАЦИИ
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    log('✅ Таблица restaurants создана/проверена');

    try {
      await client.query('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true');
    } catch (e) {
    }

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
        is_available BOOLEAN DEFAULT true,  // ДОБАВЛЕНО ДЛЯ ТЕЛЕГРАМ БОТА
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    log('✅ Таблица dishes создана/проверена');

    try {
      await client.query('ALTER TABLE dishes ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true');
    } catch (e) {
    }

    
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        dish_id INTEGER REFERENCES dishes(id),
        dish_name VARCHAR(100),
        dish_price DECIMAL(10,2),
        quantity INTEGER DEFAULT 1
      )
    `);
    log('✅ Таблица order_items создана/проверена');

    await addTestDataIfNeeded(client);

  } catch (error) {
    log(`❌ Ошибка создания таблиц: ${error.message}`);
    throw error;
  }
}

async function addTestDataIfNeeded(client) {
  try {
    const restaurantsCount = await client.query('SELECT COUNT(*) FROM restaurants');
    
    if (parseInt(restaurantsCount.rows[0].count) === 0) {
      log('🌱 Добавляем тестовые данные...');
      
      await client.query(`
        INSERT INTO restaurants (name, description, image_url, rating, delivery_time, delivery_price, categories, is_active) 
        VALUES 
        ('Пицца Мания', 'Итальянская кухня, пицца, паста', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400', 4.7, '25-35 мин', 'Бесплатно', ARRAY['Пицца', 'Итальянская', 'Паста'], true),
        ('Бургер Кинг', 'Бургеры, картофель фри, напитки', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400', 4.5, '20-30 мин', '99 ₽', ARRAY['Бургеры', 'Фастфуд'], true)
      `);
      
      await client.query(`
        INSERT INTO dishes (restaurant_id, name, description, image_url, price, ingredients, preparation_time, is_vegetarian, is_spicy, is_available) 
        VALUES 
        (1, 'Пепперони', 'Пицца с колбасками пепперони и сыром моцарелла', 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400', 699.00, ARRAY['Тесто', 'Томатный соус', 'Пепперони', 'Моцарелла'], 25, false, false, true),
        (1, 'Маргарита', 'Классическая пицца с томатами и базиликом', 'https://images.unsplash.com/photo-1604068549290-dea0e4a305ca?w=400', 599.00, ARRAY['Тесто', 'Томатный соус', 'Моцарелла', 'Томаты', 'Базилик'], 20, true, false, true),
        (2, 'Чизбургер', 'Классический бургер с сыром', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400', 299.00, ARRAY['Булочка', 'Говяжья котлета', 'Сыр', 'Лук', 'Кетчуп'], 15, false, false, true)
      `);
      
      const hashedPassword = await bcrypt.hash('password123', 10);
      await client.query(`
        INSERT INTO users (name, email, password, phone, role) 
        VALUES ('Администратор', 'admin@example.com', $1, '+7 (999) 123-45-67', 'admin')
        ON CONFLICT (email) DO NOTHING
      `, [hashedPassword]);
      
      log('✅ Тестовые данные добавлены');
    }
  } catch (error) {
    log(`⚠️ Не удалось добавить тестовые данные: ${error.message}`);
  }
}


function getUserIdFromToken(req) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const userId = req.headers['x-user-id'];
    if (userId && !isNaN(parseInt(userId))) {
      return parseInt(userId);
    }
    
    const oldToken = req.headers.authorization?.replace('Bearer ', '');
    if (oldToken && oldToken.startsWith('token_')) {
      const tokenParts = oldToken.split('_');
      if (tokenParts.length > 1 && !isNaN(parseInt(tokenParts[1]))) {
        return parseInt(tokenParts[1]);
      }
    }
    
    return null;
  }
  
  const token = authHeader.split(' ')[1];
  
  try {
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


app.get('/', (req, res) => {
  res.json({
    message: '🚀 Food Delivery API работает!',
    status: 'ok',
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    endpoints: {
      health: '/health',
      register: '/register (POST)',
      login: '/login (POST)',
      user: '/users/me (GET)',
      stats: '/users/me/stats (GET)',
      orders: '/users/me/orders (GET)',
      restaurants: '/restaurants (GET)',
      menu: '/restaurants/:id/menu (GET)',
      bot_toggle: '/bot/dish/:id/toggle (POST)'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    environment: process.env.NODE_ENV || 'development'
  });
});

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
          `INSERT INTO users (name, email, password, phone)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, email, phone, avatar_url, created_at`,
          [name, email, hashedPassword, phone || null]
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
      createdAt: new Date().toISOString()
    }
  });
}

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
          name: 'Пицца Мания',
          description: 'Итальянская кухня, пицца, паста',
          image_url: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400',
          rating: 4.7,
          delivery_time: '25-35 мин',
          delivery_price: 'Бесплатно',
          categories: ['Пицца', 'Итальянская', 'Паста']
        }
      ]);
    }

  } catch (error) {
    log(`❌ Ошибка получения ресторанов: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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
          name: 'Пепперони',
          description: 'Пицца с колбасками пепперони и сыром моцарелла',
          image_url: 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400',
          price: 699.00,
          ingredients: ['Тесто', 'Томатный соус', 'Пепперони', 'Моцарелла'],
          preparation_time: 25,
          is_vegetarian: false,
          is_spicy: false
        }
      ]);
    }

  } catch (error) {
    log(`❌ Ошибка получения меню: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/bot/dish/:id/toggle', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ 
        error: 'Неверный API ключ',
        hint: 'Установите правильный ADMIN_API_KEY'
      });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({ 
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
        error: 'Блюдо не найдено',
        dish_id: dishId
      });
    }

    const dish = result.rows[0];
    const status = dish.is_available ? 'доступно' : 'недоступно';

    res.json({
      success: true,
      message: `Блюдо "${dish.name}" теперь ${status}`,
      dish: dish,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    log(`❌ Ошибка переключения блюда: ${error.message}`);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: error.message
    });
  }
});

app.get('/bot/dish/:id', async (req, res) => {
  try {
    if (!validateAdminApiKey(req)) {
      return res.status(401).json({ error: 'Неверный API ключ' });
    }

    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({ error: 'База данных недоступна' });
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
      return res.status(404).json({ error: 'Блюдо не найдено' });
    }

    res.json({
      success: true,
      dish: result.rows[0]
    });

  } catch (error) {
    log(`❌ Ошибка получения блюда: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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
          'SELECT id, name, email, phone, avatar_url, created_at FROM users WHERE id = $1',
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
        createdAt: new Date().toISOString()
      });
    }

  } catch (error) {
    log(`❌ Ошибка получения пользователя: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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
          : null;

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
          favorite_restaurant: 'Пицца Мания'
        });
      } else {
        res.json({
          total_orders: 0,
          delivered_orders: 0,
          pending_orders: 0,
          total_spent: 0,
          average_order_value: 0,
          favorite_restaurant: null
        });
      }
    }

  } catch (error) {
    log(`❌ Ошибка получения статистики: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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
           json_agg(
             json_build_object(
               'dish_id', oi.dish_id,
               'dish_name', oi.dish_name,
               'dish_price', oi.dish_price,
               'quantity', oi.quantity
             )
           ) as items
           FROM orders o
           LEFT JOIN order_items oi ON o.id = oi.order_id
           WHERE o.user_id = $1
           GROUP BY o.id
           ORDER BY o.order_date DESC`,
          [userId]
        );

        const orders = ordersResult.rows.map(order => ({
          id: order.id.toString(),
          restaurant_name: order.restaurant_name,
          restaurant_image: order.restaurant_image,
          order_date: order.order_date.toISOString(),
          total_amount: parseFloat(order.total_amount),
          status: order.status,
          delivery_address: order.delivery_address,
          payment_method: order.payment_method,
          items: order.items || []
        }));

        res.json({ orders });

      } catch (dbError) {
        log(`❌ Ошибка базы при получении заказов: ${dbError.message}`);
        
        res.json({ orders: [] });
      }
    } else {
      if (userId === 1) {
        const mockOrders = [
          {
            id: '100',
            restaurant_name: 'Пицца Мания',
            restaurant_image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400',
            order_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            total_amount: 1200.0,
            status: 'delivered',
            delivery_address: 'ул. Ленина, д. 10, кв. 5',
            items: [
              {
                dish_id: 'p1',
                dish_name: 'Пепперони',
                dish_description: 'Пицца с колбасками пепперони и сыром моцарелла',
                dish_price: 600.0,
                dish_image: 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400',
                ingredients: ['Тесто', 'Томатный соус', 'Пепперони', 'Моцарелла'],
                preparation_time: 25,
                quantity: 2
              }
            ],
            payment_method: 'Картой онлайн'
          },
          {
            id: '101',
            restaurant_name: 'Бургер Кинг',
            restaurant_image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400',
            order_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            total_amount: 749.0,
            status: 'delivered',
            delivery_address: 'ул. Ленина, д. 10, кв. 5',
            items: [
              {
                dish_id: 'b1',
                dish_name: 'Чизбургер',
                dish_description: 'Классический бургер с сыром',
                dish_price: 299.0,
                dish_image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400',
                ingredients: ['Булочка', 'Говяжья котлета', 'Сыр', 'Лук', 'Кетчуп'],
                preparation_time: 15,
                quantity: 1
              },
              {
                dish_id: 'b3',
                dish_name: 'Картофель фри',
                dish_description: 'Хрустящий картофель фри',
                dish_price: 149.0,
                dish_image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400',
                ingredients: ['Картофель', 'Растительное масло', 'Соль'],
                preparation_time: 10,
                is_vegetarian: true,
                quantity: 3
              }
            ],
            payment_method: 'Наличными'
          }
        ];
        
        res.json({ orders: mockOrders });
      } else {
        res.json({ orders: [] });
      }
    }

  } catch (error) {
    log(`❌ Ошибка получения заказов: ${error.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});


async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      log(`\n🚀 Сервер запущен!`);
      log(`📡 Порт: ${PORT}`);
      log(`🌐 Режим базы: ${isDatabaseConnected ? '✅ Подключена' : '⚠️ Мок-режим'}`);
      log(`🔧 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
      log(`🔐 JWT_SECRET: ${JWT_SECRET ? 'Установлен' : 'Используется дефолтный'}`);
      log(`🔑 ADMIN_API_KEY: ${ADMIN_API_KEY ? 'Установлен' : 'Используется дефолтный'}`);

      if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        log(`🌍 Public URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
      } else if (process.env.RAILWAY_STATIC_URL) {
        log(`🌍 Railway URL: ${process.env.RAILWAY_STATIC_URL}`);
      } else if (process.env.NODE_ENV === 'production') {
        log(`🌍 Production mode`);
      } else {
        log(`🌍 Local URL: http://localhost:${PORT}`);
      }
      
      log(`\n🤖 Эндпоинты для Telegram бота:`);
      log(`   🔄 Переключить блюдо: POST /bot/dish/:id/toggle`);
      log(`   📋 Информация о блюде: GET /bot/dish/:id`);
      log(`   ⚠️ Заголовок: X-Admin-API-Key: ${ADMIN_API_KEY}`);
    });

  } catch (error) {
    log(`❌ Критическая ошибка запуска: ${error.message}`);
    process.exit(1);
  }
}

startServer();
