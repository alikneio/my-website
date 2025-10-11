const mysql = require('mysql2');

const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'ak_cell_db',
    port: 3306 // تأكد أنه نفس البورت
};

const connection = mysql.createConnection(dbConfig);

const products = [
    { name: 'Netflix - 1 Month', price: 10, image: '/images/netflix.png', main_cat: 'Accounts', sub_cat: 'Netflix High Quality', sub_cat_img: '/images/cat_netflix.png', req_id: 0 },
     { name: 'Netflix - 1 Month', price: 10, image: '/images/netflix.png', main_cat: 'Accounts', sub_cat: 'Netflix Normal Quality', sub_cat_img: '/images/cat_netflix.png', req_id: 0 },
    { name: 'Shahid VIP - 1 Month', price: 8, image: '/images/shahid.png', main_cat: 'Accounts', sub_cat: 'Shahid', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
    { name: 'Free Fire - 100 Diamonds', price: 1, image: '/images/ff_diamonds.png', main_cat: 'Games', sub_cat: 'Free Fire', sub_cat_img: '/images/cat_ff.png', req_id: 1 },
    { name: 'youtube- 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Youtube premuim', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
   { name: 'alfa - 1 Month', price: 8, image: '/images/.png', main_cat: 'Communication', sub_cat: 'Touch', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
   { name: 'gift cards', price: 8, image: '/images/.png', main_cat: 'Gift Cards', sub_cat: 'Touch', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
    { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Alfa', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
    { name: 'Canva - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Canva', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
      { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'CapCut', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
     { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Crunchy Roll', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
    { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Anghami', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
    { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Spotify Normal Quality', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
    { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Spotify High Quality', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
     { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'IPTV', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
      { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Gift Cards', sub_cat: 'Windows key', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
      { name: 'Anghami - 1 Month', price: 8, image: '/images/.png', main_cat: 'Accounts', sub_cat: 'Adobe Creativity Cloud', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },
];

connection.connect(err => {
    if (err) return console.error('Error connecting:', err.stack);
    console.log('Connected to MySQL to seed data.');

    const sql = `INSERT INTO products (name, price, image, main_category, sub_category, sub_category_image, requires_player_id) VALUES ?`;
    
    // تحويل مصفوفة الكائنات إلى مصفوفة من المصفوفات
    const values = products.map(p => [p.name, p.price, p.image, p.main_cat, p.sub_cat, p.sub_cat_img, p.req_id]);

    connection.query(sql, [values], (err, results) => {
        if (err) throw err;
        console.log(`Successfully inserted ${results.affectedRows} products.`);
        connection.end();
    });
});