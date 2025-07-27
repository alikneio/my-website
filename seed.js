const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./akcell.db');

const products = [
    // --- ACCOUNTS ---
    { name: 'Netflix - 1 Month', price: 10, image: '/images/netflix-icon.svg', main_cat: 'Accounts', sub_cat: 'Netflix', sub_cat_img: '/images/cat_netflix.png', req_id: 0 },
    { name: 'Shahid VIP - 1 Month', price: 8, image: '/images/shahid-svgrepo-com.svg', main_cat: 'Accounts', sub_cat: 'Shahid', sub_cat_img: '/images/cat_shahid.png', req_id: 0 },

    // --- GAMES ---
    { name: 'Free Fire - 100 Diamonds', price: 1, image: '/images/ff_diamonds.png', main_cat: 'Games', sub_cat: 'Free Fire', sub_cat_img: '/images/cat_ff.png', req_id: 1 },
    { name: 'Free Fire - Booyah Pass', price: 3, image: '/images/ff_pass.png', main_cat: 'Games', sub_cat: 'Free Fire', sub_cat_img: '/images/cat_ff.png', req_id: 1 }
];

db.serialize(() => {
    const stmt = db.prepare(`INSERT INTO products (name, price, image, main_category, sub_category, sub_category_image, requires_player_id) 
                             VALUES (?, ?, ?, ?, ?, ?, ?)`);
    
    console.log("Adding products to the database...");
    for (const p of products) {
        stmt.run(p.name, p.price, p.image, p.main_cat, p.sub_cat, p.sub_cat_img, p.req_id);
    }
    
    stmt.finalize((err) => {
        if (err) {
            console.error('Error finalizing statement:', err.message);
        } else {
            console.log("All products have been added successfully.");
        }
    });
});

db.close();