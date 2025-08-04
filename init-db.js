// init-db.js
const db = require('./database');

// ✅ users table
const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password VARCHAR(255),
    balance DECIMAL(10, 2) DEFAULT 0.00,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    phone VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    telegram_chat_id VARCHAR(50) DEFAULT NULL
  )
`;

// ✅ products table
const createProductsTable = `
  CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    image VARCHAR(255),
    main_category VARCHAR(255) NOT NULL,
    sub_category VARCHAR(255) NOT NULL,
    sub_category_image VARCHAR(255),
    requires_player_id BOOLEAN DEFAULT FALSE
  )
`;

// ✅ orders table
const createOrdersTable = `
  CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT,
    productName VARCHAR(255),
    price DECIMAL(10, 2),
    purchaseDate DATETIME,
    order_details VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'Waiting',
    admin_reply TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )
`;

// ✅ selected_api_products table
const createSelectedApiProductsTable = `
  CREATE TABLE IF NOT EXISTS selected_api_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT UNIQUE NOT NULL,
    custom_price DECIMAL(10, 2) NULL, 
    custom_image VARCHAR(255) NULL,
    category VARCHAR(50) DEFAULT NULL,
    custom_name VARCHAR(255) DEFAULT NULL,
    min_quantity INT DEFAULT 1,
    max_quantity INT DEFAULT 9999,
    active BOOLEAN DEFAULT TRUE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

// ✅ notifications table
const createNotificationsTable = `
  CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_read BOOLEAN DEFAULT FALSE
  )
`;

// ✅ transactions table
const createTransactionsTable = `
  CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    type ENUM('debit', 'credit') NOT NULL,
    amount DECIMAL(10, 2),
    reason VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

const runMigrations = async () => {
  db.query(createUsersTable, err => {
    if (err) throw err;
    console.log('✅ users table ready.');
  });

  db.query(createProductsTable, err => {
    if (err) throw err;
    console.log('✅ products table ready.');
  });

  db.query(createOrdersTable, err => {
    if (err) throw err;
    console.log('✅ orders table ready.');
  });

  db.query(createSelectedApiProductsTable, err => {
    if (err) throw err;
    console.log('✅ selected_api_products table ready.');
  });

  db.query(createNotificationsTable, err => {
    if (err) throw err;
    console.log('✅ notifications table ready.');
  });

  db.query(createTransactionsTable, err => {
    if (err) throw err;
    console.log('✅ transactions table ready.');
  });

  setTimeout(() => {
    console.log('✅ All tables initialized. You can now stop this script.');
    process.exit(0); // exit cleanly
  }, 500);
};

runMigrations();
