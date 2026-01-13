const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// Логирование при запуске
console.log('🚀 Запуск Food Delivery API...');
console.log('🔧 PORT:', PORT);
console.log('🔗 DATABASE_URL:', DATABASE_URL ? 'Есть' : 'Нет');
console.log('🔑 ADMIN_API_KEY:', process.env.ADMIN_API_KEY ? 'Есть' : 'Нет');
console.log('🔐 JWT_SECRET:', process.env.JWT_SECRET ? 'Есть' : 'Нет');

// Мидлвэры
app.use(cors());
app.use(express.json());

// Подключение к БД
let pool;
let isDatabaseConnected = false;

async function initializeDatabase() {
  try {
    console.log('🔍 Инициализация базы данных...');
    
    if (!DATABASE_URL) {
      console.log('⚠️ DATABASE_URL не найден. Работаем в мок-режиме.');
      return;
    }

    // Подключаемся к PostgreSQL
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });

    // Тестируем подключение
    const client = await pool.connect();
    console.log('✅ PostgreSQL подключен успешно!');
    
    // Создаем таблицы если их нет
    await createTablesIfNotExist(client);
    
    client.release();
    isDatabaseConnected = true;
    console.log('✅ База данных инициализирована');
    
  } catch (error) {
    console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
    console.log('📝 Работаем в мок-режиме без базы данных');
    isDatabaseConnected = false;
  }
}

async function createTablesIfNotExist(client) {
  try {
    console.log('🔧 Проверка/создание таблиц...');
    
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

    // Добавляем тестовые данные если таблицы пустые
    await seedTestData(client);
    
    console.log('✅ Таблицы созданы/проверены');
    
  } catch (error) {
    console.error('❌ Ошибка создания таблиц:', error.message);
    throw error;
  }
}

async function seedTestData(client) {
  try {
    // Проверяем есть ли уже данные
    const restaurantsCount = await client.query('SELECT COUNT(*) FROM restaurants');
    
    if (parseInt(restaurantsCount.rows[0].count) === 0) {
      console.log('🌱 Добавляем тестовые данные...');
      
      // Добавляем рестораны
      await client.query(`
        INSERT INTO restaurants (name, description, image_url, rating, delivery_time, delivery_price, categories) 
        VALUES 
        ('Пицца Мания', 'Лучшая пицца в городе', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400', 4.7, '25-35 мин', 'Бесплатно', ARRAY['Пицца', 'Итальянская']),
        ('Бургер Кинг', 'Вкуснейшие бургеры', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400', 4.5, '20-30 мин', '99 ₽', ARRAY['Бургеры', 'Фастфуд'])
        ON CONFLICT DO NOTHING
      `);
      
      // Добавляем блюда
      await client.query(`
        INSERT INTO dishes (restaurant_id, name, description, image_url, price, ingredients, preparation_time, is_vegetarian, is_spicy) 
        VALUES 
        (1, 'Пепперони', 'Острая пицца с пепперони', 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400', 699.00, ARRAY['Тесто', 'Томатный соус', 'Пепперони', 'Моцарелла'], 25, false, true),
        (1, 'Маргарита', 'Классическая пицца', 'https://images.unsplash.com/photo-1604068549290-dea0e4a305ca?w=400', 599.00, ARRAY['Тесто', 'Томатный соус', 'Моцарелла', 'Базилик'], 20, true, false),
        (2, 'Чизбургер', 'Бургер с сыром', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400', 299.00, ARRAY['Булочка', 'Говяжья котлета', 'Сыр', 'Салат'], 15, false, false)
        ON CONFLICT DO NOTHING
      `);
      
      console.log('✅ Тестовые данные добавлены');
    }
  } catch (error) {
    console.log('⚠️ Не удалось добавить тестовые данные:', error.message);
  }
}

// ===== API ЭНДПОИНТЫ =====

// 1. Health check ДОЛЖЕН БЫТЬ ПЕРВЫМ!
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    environment: process.env.NODE_ENV || 'development'
  });
});

// 2. Главная страница
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Food Delivery API работает!',
    status: 'ok',
    database: isDatabaseConnected ? 'connected' : 'mock-mode',
    endpoints: {
      health: '/health',
      restaurants: '/api/restaurants (GET)',
      menu: '/api/restaurants/:id/menu (GET)',
      debug: '/api/debug/db (GET)'
    }
  });
});

// 3. Получение ресторанов (ПУТЬ: /api/restaurants)
app.get('/api/restaurants', async (req, res) => {
  try {
    console.log('📋 Запрос ресторанов');
    
    if (isDatabaseConnected && pool) {
      const result = await pool.query(
        `SELECT id, name, description, image_url, rating,
                delivery_time, delivery_price, categories
         FROM restaurants 
         WHERE is_active = true
         ORDER BY rating DESC`
      );
      
      console.log(`✅ Найдено ${result.rows.length} ресторанов`);
      res.json(result.rows);
      
    } else {
      // Мок-данные если БД не подключена
      console.log('📝 Возвращаем мок-данные');
      res.json([
        {
          id: 1,
          name: 'Пицца Мания (Мок)',
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
    console.error('❌ Ошибка получения ресторанов:', error.message);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: error.message,
      tip: 'Проверьте подключение к базе данных'
    });
  }
});

// 4. Получение меню ресторана
app.get('/api/restaurants/:id/menu', async (req, res) => {
  try {
    const restaurantId = req.params.id;
    console.log(`🍽️ Запрос меню для ресторана ${restaurantId}`);
    
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
      // Мок-данные
      res.json([
        {
          id: 1,
          name: 'Пепперони (Мок)',
          description: 'Пицца с колбасками пепперони',
          image_url: 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400',
          price: 699.00,
          ingredients: ['Тесто', 'Томатный соус', 'Пепперони', 'Моцарелла'],
          preparation_time: 25,
          is_vegetarian: false,
          is_spicy: true
        }
      ]);
    }
    
  } catch (error) {
    console.error('❌ Ошибка получения меню:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 5. Дебаг информация о БД
app.get('/api/debug/db', async (req, res) => {
  try {
    if (!isDatabaseConnected || !pool) {
      return res.json({ 
        connected: false,
        message: 'База данных не подключена',
        database_url: DATABASE_URL ? 'Установлен' : 'Не установлен'
      });
    }
    
    // Получаем список таблиц
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    // Получаем количество записей в таблицах
    const tables = tablesResult.rows.map(row => row.table_name);
    const counts = {};
    
    for (const table of tables) {
      try {
        const countResult = await pool.query(`SELECT COUNT(*) FROM "${table}"`);
        counts[table] = parseInt(countResult.rows[0].count);
      } catch (e) {
        counts[table] = 'ошибка';
      }
    }
    
    res.json({
      connected: true,
      database: 'PostgreSQL',
      tables: tables,
      counts: counts,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.json({
      connected: false,
      error: error.message,
      hint: 'Проверьте DATABASE_URL и подключение к БД'
    });
  }
});

// 6. API для Telegram бота (простое)
app.post('/api/bot/toggle-dish/:id', async (req, res) => {
  try {
    const apiKey = req.headers['x-admin-api-key'];
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-key';
    
    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({ 
        error: 'Неверный API ключ',
        hint: 'Установите ADMIN_API_KEY в переменных окружения'
      });
    }
    
    if (!isDatabaseConnected || !pool) {
      return res.status(503).json({ 
        error: 'База данных недоступна',
        connected: isDatabaseConnected
      });
    }
    
    const dishId = req.params.id;
    
    // Пробуем обновить блюдо
    const result = await pool.query(
      `UPDATE dishes 
       SET is_available = NOT is_available,
           updated_at = CURRENT_TIMESTAMP
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
    const status = dish.is_available ? '✅ доступно' : '❌ недоступно';
    
    res.json({
      success: true,
      message: `Блюдо "${dish.name}" теперь ${status}`,
      dish: dish,
      updated: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Ошибка обновления блюда:', error);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: error.message
    });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====

async function startServer() {
  try {
    // Инициализируем базу данных
    await initializeDatabase();
    
    // Запускаем сервер
    app.listen(PORT, () => {
      console.log(`\n🎉 Сервер успешно запущен!`);
      console.log(`📡 Порт: ${PORT}`);
      console.log(`🌐 Режим базы: ${isDatabaseConnected ? '✅ Подключена' : '⚠️ Мок-режим'}`);
      console.log(`🔧 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
      console.log(`\n🔗 Эндпоинты:`);
      console.log(`   📍 Главная: /`);
      console.log(`   ❤️ Health: /health`);
      console.log(`   🍽️ Рестораны: /api/restaurants`);
      console.log(`   🍔 Меню: /api/restaurants/1/menu`);
      console.log(`   🐛 Дебаг БД: /api/debug/db`);
      
      // Показываем Railway URL
      if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        console.log(`\n🌍 Ваш API доступен по адресу:`);
        console.log(`   https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
      }
    });
    
  } catch (error) {
    console.error(`❌ Критическая ошибка запуска: ${error.message}`);
    process.exit(1);
  }
}

startServer();
