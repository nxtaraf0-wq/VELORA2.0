/**
 * VELORA - Complete Full-Stack E-commerce Website
 * File: index.js
 * 
 * Target Market: Bangladesh (BDT / ৳)
 * Payment: Cash on Delivery (COD) Only
 * Database: MongoDB Atlas (with in-memory fallback for immediate zero-config preview)
 * Architecture: Node.js, Express.js, Vercel Serverless Compatible
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { adminRouter, verifyAdminToken } from './admin.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';

// URL Normalization Middleware (Fixes Vercel "Cannot GET /index.js" rewrite artifact)
app.use((req, res, next) => {
  const vercelPath = req.headers['x-matched-path'] || 
                     req.headers['x-invoke-path'] || 
                     req.headers['x-forwarded-uri'] || 
                     req.headers['x-original-url'];

  if (vercelPath && vercelPath !== '/index.js' && !vercelPath.startsWith('/index.js')) {
    req.url = vercelPath + (req.url.includes('?') && !vercelPath.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  } else if (req.url.startsWith('/index.js/')) {
    req.url = req.url.replace('/index.js', '') || '/';
  } else if (req.url === '/index.js' || req.url.startsWith('/index.js?')) {
    if (req.headers.referer && req.headers.referer.includes('/admin')) {
      req.url = '/admin';
    } else {
      req.url = '/';
    }
  }
  next();
});

// Body & Cookie Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ----------------------------------------------------
// Database Layer: MongoDB Atlas with In-Memory Mock Fallback
// ----------------------------------------------------
class DatabaseManager {
  constructor() {
    this.client = null;
    this.db = null;
    this.isMongoConnected = false;
    this.memoryData = {
      users: [],
      products: [],
      categories: [],
      orders: [],
      banners: [],
      campaigns: [],
      discounts: [],
      coupons: [],
      settings: []
    };
  }

  toObjectId(id) {
    if (this.isMongoConnected) {
      try {
        return new ObjectId(id);
      } catch (e) {
        return id;
      }
    }
    return String(id);
  }

  async init() {
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME || 'velora_db';

    if (uri && uri.startsWith('mongodb')) {
      try {
        this.client = new MongoClient(uri, {
          maxPoolSize: 10,
          serverSelectionTimeoutMS: 5000
        });
        await this.client.connect();
        this.db = this.client.db(dbName);
        this.isMongoConnected = true;
        console.log('✓ Successfully connected to MongoDB Atlas (' + dbName + ')');

        // Create indexes safely
        await Promise.allSettled([
          this.db.collection('orders').createIndex({ orderNumber: 1 }, { unique: true }),
          this.db.collection('users').createIndex({ email: 1 }, { unique: true }),
          this.db.collection('products').createIndex({ slug: 1 }),
          this.db.collection('products').createIndex({ category: 1 }),
          this.db.collection('coupons').createIndex({ code: 1 }, { unique: true })
        ]);

        // Seed demo data if products collection is empty
        const count = await this.db.collection('products').countDocuments();
        if (count === 0) {
          await this.seedInitialData(this.db);
        }
        return;
      } catch (err) {
        console.warn('! MongoDB connection failed or URI unreachable. Using fallback in-memory store:', err.message);
        this.isMongoConnected = false;
      }
    } else {
      console.log('ℹ MONGODB_URI not provided. Running in high-performance local/in-memory mode.');
    }

    // Initialize mock database in memory
    this.seedMemoryData();
  }

  collection(name) {
    if (this.isMongoConnected && this.db) {
      return this.db.collection(name);
    }

    // In-memory collection emulator
    const self = this;
    if (!self.memoryData[name]) self.memoryData[name] = [];

    return {
      find(filter = {}) {
        let items = self.filterItems(self.memoryData[name], filter);
        const cursor = {
          sort(sortCriteria) {
            if (sortCriteria) {
              const field = Object.keys(sortCriteria)[0];
              const dir = sortCriteria[field];
              items.sort((a, b) => {
                if (a[field] < b[field]) return dir === 1 ? -1 : 1;
                if (a[field] > b[field]) return dir === 1 ? 1 : -1;
                return 0;
              });
            }
            return cursor;
          },
          limit(n) {
            items = items.slice(0, n);
            return cursor;
          },
          project() {
            return cursor;
          },
          async toArray() {
            return [...items];
          }
        };
        return cursor;
      },


      async findOne(filter = {}) {
        const items = self.filterItems(self.memoryData[name], filter);
        return items[0] || null;
      },

      async insertOne(doc) {
        const _id = (Math.random() * 1e16).toString(36) + Date.now().toString(36);
        const newDoc = { ...doc, _id };
        self.memoryData[name].push(newDoc);
        return { insertedId: _id, acknowledged: true };
      },

      async updateOne(filter, update, options = {}) {
        let doc = await this.findOne(filter);
        if (!doc) {
          if (options.upsert && update.$set) {
            const inserted = await this.insertOne(update.$set);
            return { matchedCount: 0, modifiedCount: 1, upsertedId: inserted.insertedId };
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }

        if (update.$set) {
          Object.assign(doc, update.$set);
        }
        if (update.$inc) {
          for (const key of Object.keys(update.$inc)) {
            doc[key] = (doc[key] || 0) + update.$inc[key];
          }
        }
        if (update.$push) {
          for (const key of Object.keys(update.$push)) {
            if (!Array.isArray(doc[key])) doc[key] = [];
            doc[key].push(update.$push[key]);
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },

      async deleteOne(filter) {
        const initialLen = self.memoryData[name].length;
        self.memoryData[name] = self.memoryData[name].filter(item => !self.matchesFilter(item, filter));
        return { deletedCount: initialLen - self.memoryData[name].length };
      },

      async countDocuments(filter = {}) {
        return self.filterItems(self.memoryData[name], filter).length;
      }
    };
  }

  matchesFilter(item, filter) {
    for (const key of Object.keys(filter)) {
      if (key === '$or' && Array.isArray(filter.$or)) {
        const orMatch = filter.$or.some(subFilter => this.matchesFilter(item, subFilter));
        if (!orMatch) return false;
        continue;
      }

      const val = filter[key];
      const itemVal = item[key];

      if (val && typeof val === 'object' && val.$regex) {
        const reg = new RegExp(val.$regex, val.$options || 'i');
        if (!reg.test(String(itemVal || ''))) return false;
      } else if (val && typeof val === 'object' && val.$lte !== undefined) {
        if (itemVal > val.$lte) return false;
      } else if (String(itemVal) !== String(val)) {
        return false;
      }
    }
    return true;
  }

  filterItems(list, filter) {
    if (!filter || Object.keys(filter).length === 0) return [...list];
    return list.filter(item => this.matchesFilter(item, filter));
  }

  seedMemoryData() {
    console.log('🌱 Seeding initial demo categories, products, banners, coupons, and master admin...');
    this.memoryData.users = [
      {
        _id: 'admin-master-1',
        name: 'Store Administrator',
        email: 'admin@velora.com.bd',
        username: 'admin',
        password: '$2a$10$YGtxioHFOOaqkqvcLs95ve4hD4BHEkg911RXQI7NY1ltn2u21ZwGe', // admin123
        role: 'admin',
        phone: '01700000000',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    this.memoryData.categories = [
      { _id: 'cat-1', name: 'Electronics', slug: 'electronics', description: 'Audio, gadgets, smart devices, and chargers', image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500', active: true },
      { _id: 'cat-2', name: 'Fashion & Clothing', slug: 'fashion-clothing', description: 'Comfortable casual wear, polo shirts, and traditional attires', image: 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=500', active: true },
      { _id: 'cat-3', name: 'Mobile Accessories', slug: 'mobile-accessories', description: 'Fast chargers, cables, protective cases, and powerbanks', image: 'https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=500', active: true },
      { _id: 'cat-4', name: 'Home & Kitchen', slug: 'home-kitchen', description: 'Minimalist desk lamps, bottles, organizers, and home accents', image: 'https://images.unsplash.com/photo-1534349762230-e0cadf78f5da?w=500', active: true },
      { _id: 'cat-5', name: 'Bags & Accessories', slug: 'bags-accessories', description: 'Everyday water-resistant backpacks, wallets, and travel gear', image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=500', active: true },
      { _id: 'cat-6', name: 'Sports & Fitness', slug: 'sports-fitness', description: 'Resistance bands, smart sports bands, and gym bottles', image: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=500', active: true }
    ];

    this.memoryData.products = [
      {
        _id: 'prod-1',
        name: 'VELORA Pro ANC Wireless Headphones',
        slug: 'velora-pro-anc-wireless-headphones',
        sku: 'VEL-782194',
        category: 'Electronics',
        brand: 'VELORA Studio',
        price: 1250,
        originalPrice: 1650,
        stock: 35,
        description: 'Immersive sound with 40mm titanium drivers, active noise cancellation, 35-hour battery life, and ultra-comfortable memory foam ear cushions.',
        images: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800', 'https://images.unsplash.com/photo-1583394838336-acd977736f90?w=800'],
        featured: true,
        active: true,
        attributes: { colors: ['Midnight Black', 'Platinum Silver'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-2',
        name: 'Premium Breathable Cotton T-Shirt',
        slug: 'premium-breathable-cotton-t-shirt',
        sku: 'VEL-314892',
        category: 'Fashion & Clothing',
        brand: 'VELORA Basics',
        price: 450,
        originalPrice: 590,
        stock: 60,
        description: 'Crafted from 100% comb combed organic cotton (180 GSM), pre-shrunk and tailored for all-day comfort in tropical weather.',
        images: ['https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800', 'https://images.unsplash.com/photo-1581655353564-df123a1eb820?w=800'],
        featured: true,
        active: true,
        attributes: { sizes: ['M', 'L', 'XL', 'XXL'], colors: ['Navy Blue', 'Charcoal Grey', 'Olive Green'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-3',
        name: 'Insulated Stainless Steel Water Bottle (750ml)',
        slug: 'insulated-stainless-steel-water-bottle-750ml',
        sku: 'VEL-992381',
        category: 'Home & Kitchen',
        brand: 'VELORA Living',
        price: 350,
        originalPrice: 480,
        stock: 45,
        description: 'Double-walled vacuum insulated flask keeping water cold for 24 hours or hot for 12 hours. BPA-free, leakproof bamboo lid.',
        images: ['https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=800'],
        featured: true,
        active: true,
        attributes: { colors: ['Matte Black', 'Arctic White'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-4',
        name: 'Minimalist Dimmable LED Desk Lamp',
        slug: 'minimalist-dimmable-led-desk-lamp',
        sku: 'VEL-551982',
        category: 'Home & Kitchen',
        brand: 'VELORA Living',
        price: 790,
        originalPrice: 990,
        stock: 22,
        description: 'Eye-friendly flicker-free warm and cool light modes, touch dimmer, flexible gooseneck, and built-in USB charging output.',
        images: ['https://images.unsplash.com/photo-1534349762230-e0cadf78f5da?w=800'],
        featured: true,
        active: true,
        attributes: { colors: ['White', 'Space Grey'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-5',
        name: 'Everyday Commuter Water-Resistant Backpack',
        slug: 'everyday-commuter-water-resistant-backpack',
        sku: 'VEL-664109',
        category: 'Bags & Accessories',
        brand: 'VELORA Gear',
        price: 950,
        originalPrice: 1350,
        stock: 18,
        description: 'Sleek 22L laptop backpack with padded compartment for up to 15.6 inch laptops, waterproof fabric, hidden anti-theft back pocket, and luggage strap.',
        images: ['https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800'],
        featured: true,
        active: true,
        attributes: { colors: ['Dark Heather', 'All Black'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-6',
        name: 'Ergonomic Silent Wireless Mouse',
        slug: 'ergonomic-silent-wireless-mouse',
        sku: 'VEL-112450',
        category: 'Electronics',
        brand: 'VELORA Tech',
        price: 550,
        originalPrice: 720,
        stock: 50,
        description: '2.4GHz + Dual Bluetooth connectivity, silent whisper-quiet click switches, 3-level adjustable DPI (800/1200/1600), and rechargeable battery.',
        images: ['https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=800'],
        featured: false,
        active: true,
        attributes: { colors: ['Matte Black', 'Silver Grey'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-7',
        name: '65W GaN Fast Dual-Port USB-C Charger',
        slug: '65w-gan-fast-dual-port-usb-c-charger',
        sku: 'VEL-440129',
        category: 'Mobile Accessories',
        brand: 'VELORA Tech',
        price: 890,
        originalPrice: 1150,
        stock: 30,
        description: 'Ultra-compact Gallium Nitride (GaN) high-speed charger supporting Power Delivery 3.0. Charges smartphones, tablets, and laptops safely.',
        images: ['https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=800'],
        featured: true,
        active: true,
        attributes: { colors: ['Pure White'] },
        createdAt: new Date()
      },
      {
        _id: 'prod-8',
        name: 'Heavy Duty 5-Level Workout Resistance Bands',
        slug: 'heavy-duty-workout-resistance-bands',
        sku: 'VEL-882014',
        category: 'Sports & Fitness',
        brand: 'VELORA Fitness',
        price: 390,
        originalPrice: 550,
        stock: 40,
        description: 'Set of 5 natural latex loop exercise bands with varying tension levels from Light to XX-Heavy. Includes breathable carrying travel pouch.',
        images: ['https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=800'],
        featured: false,
        active: true,
        createdAt: new Date()
      }
    ];

    this.memoryData.banners = [
      {
        _id: 'ban-1',
        title: 'Elevate Your Everyday Lifestyle',
        subtitle: 'Curated premium electronics, fashion, and home essentials with Cash on Delivery nationwide.',
        badge: 'EXCLUSIVE SPRING DROP',
        image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1600&auto=format&fit=crop&q=80',
        buttonText: 'Explore Collection',
        link: '/#products',
        order: 1,
        active: true,
        createdAt: new Date()
      },
      {
        _id: 'ban-2',
        title: 'Smart Audio & Workspace Gear',
        subtitle: 'Enjoy up to 30% savings on noise-cancelling headphones and desk setup accessories.',
        badge: 'TECH SHOWCASE',
        image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1600&auto=format&fit=crop&q=80',
        buttonText: 'Shop Electronics',
        link: '/#products?category=Electronics',
        order: 2,
        active: true,
        createdAt: new Date()
      }
    ];

    this.memoryData.campaigns = [
      {
        _id: 'camp-1',
        name: 'Eid Mega Celebration Sale',
        slug: 'eid-mega-sale',
        description: 'Special festive celebration discounts on selected apparel, gadgets, and home gifts.',
        image: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=800',
        discountType: 'percentage',
        discountValue: 15,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        active: true,
        createdAt: new Date()
      }
    ];

    this.memoryData.coupons = [
      {
        _id: 'coup-1',
        code: 'VELORA10',
        description: '10% discount on orders above ৳500',
        discountType: 'percentage',
        discountValue: 10,
        minOrderAmount: 500,
        maxDiscountAmount: 250,
        totalUsageLimit: 500,
        perCustomerLimit: 2,
        usedCount: 14,
        usedBy: [],
        startDate: new Date(),
        expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        active: true,
        createdAt: new Date()
      },
      {
        _id: 'coup-2',
        code: 'SAVE100',
        description: '৳100 flat discount on orders above ৳1,000',
        discountType: 'fixed',
        discountValue: 100,
        minOrderAmount: 1000,
        maxDiscountAmount: 100,
        totalUsageLimit: 200,
        perCustomerLimit: 1,
        usedCount: 8,
        usedBy: [],
        startDate: new Date(),
        expiryDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        active: true,
        createdAt: new Date()
      }
    ];

    this.memoryData.settings = [
      {
        _id: 'set-1',
        type: 'store_settings',
        storeName: 'VELORA',
        tagline: 'Premium Single-Vendor Online Store in Bangladesh',
        phone: '+880 1700-000000',
        email: 'support@velora.com.bd',
        address: 'House 14, Road 7, Banani, Dhaka-1213, Bangladesh',
        deliveryInsideDhaka: 60,
        deliveryOutsideDhaka: 120,
        freeDeliveryMinSpend: 2500,
        announcementBar: '🎉 Free Home Delivery across Bangladesh on orders over ৳2,500! Cash on Delivery available.',
        currency: 'BDT',
        currencySymbol: '৳'
      }
    ];

    this.memoryData.orders = [
      {
        _id: 'ord-demo-1',
        orderNumber: 'VEL-1001',
        customerId: 'cust-1',
        customerInfo: {
          name: 'Tanvir Ahmed',
          phone: '01711223344',
          email: 'tanvir@example.com',
          address: 'House 22, Road 4, Sector 3, Uttara',
          city: 'Dhaka',
          deliveryNotes: 'Please call before delivery'
        },
        items: [
          {
            productId: 'prod-1',
            name: 'Velora BassPro Wireless Noise Cancelling Earbuds',
            slug: 'velora-basspro-wireless-noise-cancelling-earbuds',
            sku: 'VEL-294011',
            image: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800',
            price: 1850,
            quantity: 1,
            selectedColor: 'Matte Black'
          }
        ],
        subtotal: 1850,
        deliveryCharge: 60,
        discountAmount: 0,
        appliedCoupon: null,
        finalAmount: 1910,
        paymentMethod: 'Cash on Delivery (COD)',
        paymentStatus: 'Pending Collection',
        orderStatus: 'Shipped',
        stockRestored: false,
        timeline: [
          { status: 'Pending Confirmation', timestamp: new Date(Date.now() - 36 * 3600 * 1000), note: 'Order placed via Cash on Delivery' },
          { status: 'Confirmed', timestamp: new Date(Date.now() - 24 * 3600 * 1000), note: 'Order confirmed with customer over phone' },
          { status: 'Processing', timestamp: new Date(Date.now() - 16 * 3600 * 1000), note: 'Package quality-checked and packed in VELORA box' },
          { status: 'Shipped', timestamp: new Date(Date.now() - 6 * 3600 * 1000), note: 'Handed over to courier hub for dispatch' }
        ],
        createdAt: new Date(Date.now() - 36 * 3600 * 1000),
        updatedAt: new Date(Date.now() - 6 * 3600 * 1000)
      }
    ];
  }

  async seedInitialData(db) {
    console.log('Seeding initial MongoDB Atlas collections...');
    this.seedMemoryData();
    for (const key of ['users', 'categories', 'products', 'banners', 'campaigns', 'coupons', 'settings', 'orders']) {
      if (this.memoryData[key].length > 0) {
        await db.collection(key).insertMany(this.memoryData[key]);
      }
    }
  }
}

const dbManager = new DatabaseManager();
await dbManager.init();
app.locals.db = dbManager;

// ----------------------------------------------------
// Customer Authentication Middleware
// ----------------------------------------------------
export function verifyCustomerToken(req, res, next) {
  const token = req.cookies?.velora_token || 
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
      ? req.headers.authorization.split(' ')[1] 
      : null);

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.customer = decoded;
    next();
  } catch (err) {
    res.clearCookie('velora_token');
    return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  }
}

// Optional Auth (populates req.customer if valid token present)
export function optionalCustomerToken(req, res, next) {
  const token = req.cookies?.velora_token || 
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
      ? req.headers.authorization.split(' ')[1] 
      : null);

  if (token) {
    try {
      req.customer = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      req.customer = null;
    }
  }
  next();
}

// Mount the Admin router on /admin and root
app.use('/admin', adminRouter);
app.use('/index.js/admin', adminRouter);
app.use(adminRouter);

// ----------------------------------------------------
// Public REST API Endpoints
// ----------------------------------------------------

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    store: 'VELORA',
    market: 'Bangladesh',
    currency: 'BDT (৳)',
    payment: 'Cash on Delivery Only',
    database: dbManager.isMongoConnected ? 'MongoDB Atlas' : 'In-Memory Mock Storage',
    timestamp: new Date()
  });
});

// Categories list
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await dbManager.collection('categories').find({ active: true }).sort({ name: 1 }).toArray();
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Products catalog with search, category filtering, price bounds, sorting, pagination
app.get('/api/products', async (req, res) => {
  try {
    const { category, search, minPrice, maxPrice, sort, featured, limit = 40, page = 1 } = req.query;
    let query = { active: true };

    if (category && category !== 'All') {
      query.category = category;
    }
    if (featured === 'true') {
      query.featured = true;
    }
    if (search) {
      query.$or = [
        { name: { $regex: search.trim(), $options: 'i' } },
        { description: { $regex: search.trim(), $options: 'i' } },
        { brand: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    let products = await dbManager.collection('products').find(query).toArray();

    // In-memory price and sort filters
    if (minPrice) products = products.filter(p => p.price >= Number(minPrice));
    if (maxPrice) products = products.filter(p => p.price <= Number(maxPrice));

    if (sort === 'price_asc') products.sort((a, b) => a.price - b.price);
    else if (sort === 'price_desc') products.sort((a, b) => b.price - a.price);
    else if (sort === 'name') products.sort((a, b) => a.name.localeCompare(b.name));
    else products.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const total = products.length;
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginated = products.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      products: paginated
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Product Details + Related Products
app.get('/api/products/:slug', async (req, res) => {
  try {
    const product = await dbManager.collection('products').findOne({ slug: req.params.slug, active: true });
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const related = await dbManager.collection('products')
      .find({ category: product.category, active: true, slug: { $ne: product.slug } })
      .limit(4)
      .toArray();

    res.json({ success: true, product, related });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Active Banners
app.get('/api/banners', async (req, res) => {
  try {
    const banners = await dbManager.collection('banners').find({ active: true }).sort({ order: 1 }).toArray();
    res.json({ success: true, banners });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Active Campaigns
app.get('/api/campaigns', async (req, res) => {
  try {
    const now = new Date();
    const campaigns = await dbManager.collection('campaigns').find({ active: true }).toArray();
    // Exclude expired
    const activeCampaigns = campaigns.filter(c => !c.endDate || new Date(c.endDate) >= now);
    res.json({ success: true, campaigns: activeCampaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/campaigns/:slug', async (req, res) => {
  try {
    const campaign = await dbManager.collection('campaigns').findOne({ slug: req.params.slug, active: true });
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found or expired' });
    }
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Store Settings (Public view)
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await dbManager.collection('settings').findOne({ type: 'store_settings' });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Customer Authentication Endpoints
// ----------------------------------------------------

// Customer Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password, address, city } = req.body;
    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Please provide valid name, email, and password (min 6 characters)' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await dbManager.collection('users').findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({ success: false, error: 'An account with this email address already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newCustomer = {
      name: name.trim(),
      email: normalizedEmail,
      phone: (phone || '').trim(),
      password: hashedPassword,
      role: 'customer', // strictly enforce customer role
      address: address || '',
      city: city || 'Dhaka',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await dbManager.collection('users').insertOne(newCustomer);
    const token = jwt.sign(
      { id: result.insertedId.toString(), email: newCustomer.email, name: newCustomer.name, role: 'customer' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.cookie('velora_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.status(201).json({
      success: true,
      token,
      customer: {
        id: result.insertedId,
        name: newCustomer.name,
        email: newCustomer.email,
        phone: newCustomer.phone,
        address: newCustomer.address,
        city: newCustomer.city
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await dbManager.collection('users').findOne({ email: normalizedEmail });
    if (!user || user.role === 'admin') {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, name: user.name, role: 'customer' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.cookie('velora_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      token,
      customer: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        city: user.city
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('velora_token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Current Customer session info
app.get('/api/auth/me', optionalCustomerToken, async (req, res) => {
  if (!req.customer) {
    return res.json({ success: false, customer: null });
  }
  try {
    const user = await dbManager.collection('users').findOne({ _id: dbManager.toObjectId(req.customer.id) });
    if (!user) return res.json({ success: false, customer: null });

    res.json({
      success: true,
      customer: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        city: user.city
      }
    });
  } catch (err) {
    res.json({ success: false, customer: null });
  }
});

// Customer Profile details
app.get('/api/account', verifyCustomerToken, async (req, res) => {
  try {
    const user = await dbManager.collection('users').findOne({ _id: dbManager.toObjectId(req.customer.id) });
    if (!user) return res.status(404).json({ success: false, error: 'Account not found' });

    res.json({
      success: true,
      profile: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        city: user.city,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Customer Profile
app.patch('/api/account', verifyCustomerToken, async (req, res) => {
  try {
    const { name, phone, address, city, currentPassword, newPassword } = req.body;
    const user = await dbManager.collection('users').findOne({ _id: dbManager.toObjectId(req.customer.id) });
    if (!user) return res.status(404).json({ success: false, error: 'Account not found' });

    const updateFields = { updatedAt: new Date() };
    if (name) updateFields.name = name.trim();
    if (phone !== undefined) updateFields.phone = phone.trim();
    if (address !== undefined) updateFields.address = address.trim();
    if (city !== undefined) updateFields.city = city.trim();

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, error: 'Current password is required to change password' });
      }
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) {
        return res.status(400).json({ success: false, error: 'Current password does not match' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
      }
      updateFields.password = await bcrypt.hash(newPassword, 10);
    }

    await dbManager.collection('users').updateOne(
      { _id: dbManager.toObjectId(req.customer.id) },
      { $set: updateFields }
    );

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer's Own Order History
app.get('/api/account/orders', verifyCustomerToken, async (req, res) => {
  try {
    const orders = await dbManager.collection('orders')
      .find({ $or: [{ customerId: req.customer.id }, { 'customerInfo.email': req.customer.email }] })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Coupon Validation & Calculation Engine
// ----------------------------------------------------
app.post('/api/coupons/validate', optionalCustomerToken, async (req, res) => {
  try {
    const { code, cartSubtotal, items = [] } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Please enter a coupon code' });
    }

    const subtotal = Number(cartSubtotal) || 0;
    const normalizedCode = code.trim().toUpperCase();

    const coupon = await dbManager.collection('coupons').findOne({ code: normalizedCode });
    if (!coupon || !coupon.active) {
      return res.status(400).json({ success: false, error: 'Invalid or expired coupon code' });
    }

    // Check dates
    const now = new Date();
    if (coupon.startDate && new Date(coupon.startDate) > now) {
      return res.status(400).json({ success: false, error: 'This coupon promotion has not started yet' });
    }
    if (coupon.expiryDate && new Date(coupon.expiryDate) < now) {
      return res.status(400).json({ success: false, error: 'This coupon code has expired' });
    }

    // Check total usage limit
    if (coupon.totalUsageLimit && (coupon.usedCount || 0) >= coupon.totalUsageLimit) {
      return res.status(400).json({ success: false, error: 'Coupon usage limit has been reached' });
    }

    // Check per-customer limit
    if (req.customer && coupon.perCustomerLimit && Array.isArray(coupon.usedBy)) {
      const customerUses = coupon.usedBy.filter(id => String(id) === String(req.customer.id)).length;
      if (customerUses >= coupon.perCustomerLimit) {
        return res.status(400).json({ success: false, error: 'You have already used this coupon the maximum allowed times' });
      }
    }

    // Check minimum order value
    if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount) {
      return res.status(400).json({ 
        success: false, 
        error: `Minimum order of ৳${coupon.minOrderAmount.toLocaleString()} required for this coupon` 
      });
    }

    // Calculate discount on server
    let discount = 0;
    if (coupon.discountType === 'percentage') {
      discount = (subtotal * coupon.discountValue) / 100;
    } else {
      discount = Math.min(coupon.discountValue, subtotal);
    }

    // Cap at max discount if configured
    if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
      discount = coupon.maxDiscountAmount;
    }

    discount = Math.round(discount);
    const newTotal = Math.max(0, subtotal - discount);

    res.json({
      success: true,
      coupon: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        discountAmount: discount,
        newTotal
      },
      message: `Coupon applied: ৳${discount.toLocaleString()} savings!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Order Creation (Cash on Delivery Only) & Order Tracking
// ----------------------------------------------------

/**
 * Generate readable, collision-resistant order number: VEL-YYYYMMDD-XXXXXX
 */
function generateOrderNumber() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32 without easily confused 0,1,I,O
  let randomStr = '';
  for (let i = 0; i < 6; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `VEL-${dateStr}-${randomStr}`;
}

// Create Order (Cash on Delivery checkout)
app.post('/api/orders', optionalCustomerToken, async (req, res) => {
  try {
    const {
      customerInfo,
      items,
      couponCode,
      deliveryArea // 'inside_dhaka' or 'outside_dhaka'
    } = req.body;

    if (!customerInfo || !customerInfo.name || !customerInfo.phone || !customerInfo.address) {
      return res.status(400).json({ success: false, error: 'Name, phone number, and delivery address are required' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Your cart is empty' });
    }

    // Verify all items, prices, and stock strictly from database
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const product = await dbManager.collection('products').findOne({ 
        $or: [
          { _id: dbManager.toObjectId(item.productId) },
          { slug: item.slug }
        ]
      });

      if (!product || !product.active) {
        return res.status(400).json({ success: false, error: `Product "${item.name || 'item'}" is currently unavailable` });
      }

      const qty = Math.max(1, parseInt(item.quantity) || 1);
      if (product.stock < qty) {
        return res.status(400).json({ 
          success: false, 
          error: `Insufficient stock for "${product.name}". Only ${product.stock} left in stock.` 
        });
      }

      const trustedPrice = product.price;
      subtotal += trustedPrice * qty;

      verifiedItems.push({
        productId: product._id.toString(),
        name: product.name,
        slug: product.slug,
        sku: product.sku || '',
        image: (product.images && product.images[0]) || '',
        price: trustedPrice,
        quantity: qty,
        selectedSize: item.selectedSize || '',
        selectedColor: item.selectedColor || ''
      });
    }

    // Retrieve store settings for delivery charge
    let settings = await dbManager.collection('settings').findOne({ type: 'store_settings' });
    const insideDhakaFee = settings?.deliveryInsideDhaka ?? 60;
    const outsideDhakaFee = settings?.deliveryOutsideDhaka ?? 120;
    const freeDeliveryThreshold = settings?.freeDeliveryMinSpend ?? 2500;

    let deliveryCharge = (deliveryArea === 'outside_dhaka' || (customerInfo.city && customerInfo.city.toLowerCase() !== 'dhaka')) 
      ? outsideDhakaFee 
      : insideDhakaFee;

    // Free delivery check
    if (subtotal >= freeDeliveryThreshold) {
      deliveryCharge = 0;
    }

    // Validate coupon server-side
    let discountAmount = 0;
    let appliedCoupon = null;

    if (couponCode) {
      const normalizedCode = couponCode.trim().toUpperCase();
      const coupon = await dbManager.collection('coupons').findOne({ code: normalizedCode, active: true });
      if (coupon) {
        const now = new Date();
        const validDates = (!coupon.startDate || new Date(coupon.startDate) <= now) &&
                           (!coupon.expiryDate || new Date(coupon.expiryDate) >= now);
        const validLimit = !coupon.totalUsageLimit || (coupon.usedCount || 0) < coupon.totalUsageLimit;
        const validMin = !coupon.minOrderAmount || subtotal >= coupon.minOrderAmount;

        if (validDates && validLimit && validMin) {
          if (coupon.discountType === 'percentage') {
            discountAmount = (subtotal * coupon.discountValue) / 100;
          } else {
            discountAmount = Math.min(coupon.discountValue, subtotal);
          }
          if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
            discountAmount = coupon.maxDiscountAmount;
          }
          discountAmount = Math.round(discountAmount);
          appliedCoupon = coupon.code;
        }
      }
    }

    const finalAmount = Math.max(0, subtotal + deliveryCharge - discountAmount);

    // Atomic Stock Decrement
    for (const item of verifiedItems) {
      await dbManager.collection('products').updateOne(
        { _id: dbManager.toObjectId(item.productId) },
        { $inc: { stock: -item.quantity } }
      );
    }

    // Generate unique order number
    let orderNumber = generateOrderNumber();
    let collisionCheck = await dbManager.collection('orders').findOne({ orderNumber });
    let attempts = 0;
    while (collisionCheck && attempts < 5) {
      orderNumber = generateOrderNumber();
      collisionCheck = await dbManager.collection('orders').findOne({ orderNumber });
      attempts++;
    }

    const newOrder = {
      orderNumber,
      customerId: req.customer ? req.customer.id : null,
      customerInfo: {
        name: customerInfo.name.trim(),
        phone: customerInfo.phone.trim(),
        email: customerInfo.email ? customerInfo.email.trim() : (req.customer ? req.customer.email : ''),
        address: customerInfo.address.trim(),
        city: customerInfo.city ? customerInfo.city.trim() : 'Dhaka',
        deliveryNotes: customerInfo.deliveryNotes ? customerInfo.deliveryNotes.trim() : ''
      },
      items: verifiedItems,
      subtotal,
      deliveryCharge,
      discountAmount,
      appliedCoupon,
      finalAmount,
      paymentMethod: 'Cash on Delivery (COD)',
      paymentStatus: 'Pending Collection', // Initial COD state
      orderStatus: 'Pending Confirmation',
      stockRestored: false,
      timeline: [
        {
          status: 'Pending Confirmation',
          paymentStatus: 'Pending Collection',
          note: 'Order placed by customer via Cash on Delivery. Awaiting phone confirmation.',
          timestamp: new Date()
        }
      ],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const insertResult = await dbManager.collection('orders').insertOne(newOrder);

    // Increment coupon usage
    if (appliedCoupon) {
      await dbManager.collection('coupons').updateOne(
        { code: appliedCoupon },
        {
          $inc: { usedCount: 1 },
          $push: { usedBy: req.customer ? req.customer.id : 'guest' }
        }
      );
    }

    res.status(201).json({
      success: true,
      orderNumber,
      order: {
        _id: insertResult.insertedId,
        orderNumber,
        finalAmount,
        deliveryCharge,
        subtotal,
        discountAmount,
        paymentMethod: newOrder.paymentMethod,
        paymentStatus: newOrder.paymentStatus,
        orderStatus: newOrder.orderStatus
      },
      message: 'Order placed successfully! We will contact you soon for confirmation.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Order Tracking & Details
app.get('/api/orders/:orderNumber', optionalCustomerToken, async (req, res) => {
  try {
    const orderNumber = req.params.orderNumber.trim().toUpperCase();
    const order = await dbManager.collection('orders').findOne({ orderNumber });

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found. Please verify the order number.' });
    }

    // Security check: allow if logged in owner, or if customer supplies verified phone via query
    const verifiedPhone = (req.query.phone || '').trim();
    const isOwner = req.customer && (order.customerId === req.customer.id || order.customerInfo?.email === req.customer.email);

    if (!isOwner && verifiedPhone && order.customerInfo?.phone && !order.customerInfo.phone.endsWith(verifiedPhone.slice(-6))) {
      return res.status(403).json({ success: false, error: 'Phone number verification failed for this order' });
    }

    // Obfuscate phone & address if public unauthenticated tracking without phone
    const safeOrder = {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      items: order.items,
      subtotal: order.subtotal,
      deliveryCharge: order.deliveryCharge,
      discountAmount: order.discountAmount,
      finalAmount: order.finalAmount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      timeline: order.timeline || [],
      customerInfo: {
        name: order.customerInfo?.name || 'Customer',
        city: order.customerInfo?.city || 'Dhaka',
        phone: isOwner || verifiedPhone ? order.customerInfo?.phone : '••••••' + (order.customerInfo?.phone || '').slice(-4),
        address: isOwner || verifiedPhone ? order.customerInfo?.address : 'Delivery Address Protected'
      }
    };

    res.json({ success: true, order: safeOrder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer Cancel Eligible Order
app.post('/api/orders/:orderNumber/cancel', verifyCustomerToken, async (req, res) => {
  try {
    const orderNumber = req.params.orderNumber.trim().toUpperCase();
    const order = await dbManager.collection('orders').findOne({ orderNumber });

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Only allow customer to cancel their own order
    if (order.customerId !== req.customer.id && order.customerInfo?.email !== req.customer.email) {
      return res.status(403).json({ success: false, error: 'You are not authorized to cancel this order' });
    }

    if (order.orderStatus !== 'Pending Confirmation') {
      return res.status(400).json({ 
        success: false, 
        error: `Order cannot be cancelled because it is already in "${order.orderStatus}" state. Please contact customer care.` 
      });
    }

    // Restore inventory stock safely
    if (!order.stockRestored && Array.isArray(order.items)) {
      for (const item of order.items) {
        await dbManager.collection('products').updateOne(
          { _id: dbManager.toObjectId(item.productId) },
          { $inc: { stock: item.quantity } }
        );
      }
    }

    const cancelTimeline = {
      status: 'Cancelled',
      paymentStatus: 'Cancelled',
      note: 'Order cancelled by customer via account portal.',
      timestamp: new Date(),
      updatedBy: req.customer.email
    };

    await dbManager.collection('orders').updateOne(
      { orderNumber },
      {
        $set: {
          orderStatus: 'Cancelled',
          stockRestored: true,
          updatedAt: new Date()
        },
        $push: { timeline: cancelTimeline }
      }
    );

    res.json({ success: true, message: 'Order has been successfully cancelled and items returned to stock.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Frontend Web Storefront (Embedded High-Performance SPA)
// ----------------------------------------------------
app.get(['/', '/products', '/checkout', '/track-order', '/account', '/index.js'], (req, res) => {
  res.send(renderStorefrontHtml());
});

function renderStorefrontHtml() {
  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VELORA - Premium Online Shopping Bangladesh | Cash on Delivery</title>
  <meta name="description" content="Shop premium electronics, contemporary fashion, mobile accessories, and lifestyle essentials at VELORA Bangladesh. Nationwide Cash on Delivery & 7-day returns.">
  <meta property="og:title" content="VELORA - Premium Online Shopping Bangladesh">
  <meta property="og:description" content="Authentic products, best prices in BDT, Cash on Delivery across Bangladesh.">
  <meta property="og:type" content="website">
  
  <!-- Tailwind CSS & Google Fonts -->
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap" rel="stylesheet">

  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Plus Jakarta Sans', 'sans-serif'],
            serif: ['Playfair Display', 'serif']
          },
          colors: {
            brand: {
              50: '#eef2ff',
              100: '#e0e7ff',
              500: '#6366f1',
              600: '#4f46e5',
              700: '#4338ca',
              900: '#1e1b4b'
            }
          }
        }
      }
    }
  </script>

  <style>
    /* Custom refined styling */
    .hero-glow {
      background: radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.15), transparent 70%);
    }
    .custom-scroll::-webkit-scrollbar {
      height: 6px;
      width: 6px;
    }
    .custom-scroll::-webkit-scrollbar-thumb {
      background: #cbd5e1;
      border-radius: 9999px;
    }
    .bdt-symbol:before {
      content: '৳';
      margin-right: 2px;
    }
  </style>
</head>
<body class="bg-[#fafafa] text-slate-900 font-sans antialiased min-h-screen flex flex-col selection:bg-indigo-500 selection:text-white">

  <!-- 1. Top Announcement Bar -->
  <aside id="announcement-bar" class="bg-slate-950 text-slate-200 text-xs py-2.5 px-4 text-center font-medium tracking-wide flex items-center justify-center space-x-2 border-b border-slate-800">
    <span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
    <span id="announcement-text">🎉 Exclusive Offer: Free Home Delivery across Bangladesh on orders over ৳2,500! Cash on Delivery available.</span>
  </aside>

  <!-- 2. Sticky Header & Navigation -->
  <header class="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-100 shadow-sm transition-all duration-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-20">
        
        <!-- Logo & Brand -->
        <div class="flex items-center space-x-8">
          <a href="/" class="flex items-center space-x-2.5 group">
            <div class="w-10 h-10 rounded-2xl bg-slate-950 flex items-center justify-center text-white font-extrabold text-xl shadow-lg shadow-slate-950/20 group-hover:scale-105 transition transform">
              V
            </div>
            <div>
              <span class="text-2xl font-black tracking-tighter text-slate-950 block leading-none">VELORA</span>
              <span class="text-[9px] font-bold uppercase tracking-widest text-indigo-600">Bangladesh</span>
            </div>
          </a>

          <!-- Desktop Category Links -->
          <nav class="hidden md:flex items-center space-x-6 text-sm font-semibold text-slate-600">
            <a href="/#products" onclick="filterByCategory('All')" class="hover:text-indigo-600 transition">All Products</a>
            <a href="/#products" onclick="filterByCategory('Electronics')" class="hover:text-indigo-600 transition">Electronics</a>
            <a href="/#products" onclick="filterByCategory('Fashion & Clothing')" class="hover:text-indigo-600 transition">Fashion</a>
            <a href="/#products" onclick="filterByCategory('Home & Kitchen')" class="hover:text-indigo-600 transition">Home & Living</a>
            <a href="/#products" onclick="filterByCategory('Mobile Accessories')" class="hover:text-indigo-600 transition">Accessories</a>
          </nav>
        </div>

        <!-- Center Search Bar (Desktop) -->
        <div class="hidden lg:flex items-center flex-1 max-w-md mx-8">
          <div class="relative w-full">
            <input type="text" id="store-search" oninput="debounce(handleSearch, 300)()" placeholder="Search gadgets, shirts, headphones..." 
              class="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs sm:text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:bg-white focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 transition">
            <svg class="w-4 h-4 text-slate-400 absolute left-3.5 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
          </div>
        </div>

        <!-- Right Action Icons: Track Order, Customer Account, Shopping Cart, Three-Dot Menu -->
        <div class="flex items-center space-x-2 sm:space-x-3">
          <!-- Order Tracking Button -->
          <a href="/track-order" onclick="openTrackOrderModal(event)" class="text-xs font-semibold text-slate-600 hover:text-slate-950 px-3 py-2 rounded-xl hover:bg-slate-100 transition flex items-center space-x-1.5">
            <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            <span class="hidden sm:inline">Track Order</span>
          </a>

          <!-- Customer Auth / Profile Button -->
          <div class="relative" id="auth-container">
            <button onclick="toggleAuthModal()" id="btn-user-account" class="text-xs font-semibold text-slate-700 hover:text-slate-950 px-3 py-2 rounded-xl border border-slate-200/80 hover:bg-slate-50 transition flex items-center space-x-2">
              <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
              <span id="user-display-name">Account</span>
            </button>
          </div>

          <!-- Shopping Cart Drawer Trigger -->
          <button onclick="toggleCartDrawer()" class="relative p-2.5 bg-slate-950 text-white rounded-2xl hover:bg-indigo-600 shadow-md shadow-slate-950/10 transition flex items-center justify-center">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
            <span id="cart-badge" class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-indigo-500 text-white text-[10px] font-black rounded-full flex items-center justify-center border-2 border-white shadow">0</span>
          </button>

          <!-- Three-Dot (•••) Quick Action Menu -->
          <div class="relative">
            <button id="btn-three-dot" onclick="toggleThreeDotMenu(event)" title="মেনু / Quick Menu" class="p-2.5 rounded-2xl border border-slate-200/80 hover:bg-slate-100 text-slate-700 hover:text-slate-950 transition flex items-center justify-center">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="12" cy="19" r="2"/>
              </svg>
            </button>
            <!-- Dropdown Menu -->
            <div id="three-dot-dropdown" class="hidden absolute right-0 mt-2 w-64 bg-white rounded-2xl shadow-2xl border border-slate-200 py-2 z-50">
              <div class="px-4 py-2 border-b border-slate-100">
                <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">কুইক মেনু (Quick Actions)</p>
              </div>
              <a href="/track-order" onclick="openTrackOrderModal(event); closeThreeDotMenu();" class="flex items-center space-x-3 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-indigo-50 hover:text-indigo-600 transition">
                <span class="w-7 h-7 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">📦</span>
                <div>
                  <div class="font-bold text-slate-900">তোমার অর্ডার চেক করো</div>
                  <div class="text-[10px] text-slate-500 font-normal">Track order status real-time</div>
                </div>
              </a>
              <a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-amber-50 hover:text-amber-700 transition">
                <span class="w-7 h-7 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">👑</span>
                <div>
                  <div class="font-bold text-slate-900">অ্যাডমিন ড্যাশবোর্ড</div>
                  <div class="text-[10px] text-slate-500 font-normal">Store Owner Portal (/admin)</div>
                </div>
              </a>
              <button onclick="toggleAuthModal(); closeThreeDotMenu();" class="w-full text-left flex items-center space-x-3 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 transition">
                <span class="w-7 h-7 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold">👤</span>
                <div>
                  <div class="font-bold text-slate-900">আমার অ্যাকাউন্ট</div>
                  <div class="text-[10px] text-slate-500 font-normal">Customer profile & history</div>
                </div>
              </button>
              <button onclick="toggleCartDrawer(); closeThreeDotMenu();" class="w-full text-left flex items-center space-x-3 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition">
                <span class="w-7 h-7 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">🛒</span>
                <div>
                  <div class="font-bold text-slate-900">শপিং ব্যাগ (Cart)</div>
                  <div class="text-[10px] text-slate-500 font-normal">View items & checkout</div>
                </div>
              </button>
              <div class="border-t border-slate-100 mt-1 pt-1.5 px-4 py-2">
                <div class="flex items-center space-x-2 text-[11px] text-slate-500">
                  <span>📞</span>
                  <span>সহায়তা: <strong class="text-slate-800">01700-000000</strong></span>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>

      <!-- Mobile Search Bar -->
      <div class="lg:hidden pb-4">
        <div class="relative w-full">
          <input type="text" id="mobile-search" oninput="debounce(handleMobileSearch, 300)()" placeholder="Search products in Bangladesh..." 
            class="w-full pl-10 pr-4 py-2 bg-slate-100 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-indigo-100">
          <svg class="w-4 h-4 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
        </div>
      </div>
    </div>
  </header>

  <!-- 3. HERO PROMOTIONAL BANNER SECTION -->
  <section class="relative overflow-hidden bg-white border-b border-slate-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div id="hero-slider" class="relative rounded-3xl overflow-hidden bg-slate-950 min-h-[360px] sm:min-h-[480px] flex items-center shadow-xl shadow-slate-950/5">
        <!-- Banner Slides Injected via JS -->
        <div id="banner-container" class="w-full h-full relative">
          <!-- Placeholder until loaded -->
          <div class="p-8 sm:p-16 max-w-xl text-white space-y-4">
            <span class="px-3 py-1 rounded-full text-[11px] font-bold tracking-wider uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-400/30">
              PREMIUM SELECTION
            </span>
            <h1 class="text-3xl sm:text-5xl font-extrabold tracking-tight leading-tight">
              Crafted for Elegance. Delivered to Your Door.
            </h1>
            <p class="text-sm sm:text-base text-slate-300 font-normal">
              Explore authentic lifestyle electronics, fashion, and home goods with Cash on Delivery across Bangladesh.
            </p>
            <div class="pt-2">
              <a href="#products" class="inline-flex items-center space-x-2 px-6 py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-lg shadow-indigo-600/30 transition">
                <span>Shop Catalog</span>
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
              </a>
            </div>
          </div>
        </div>

        <!-- Slider Dots -->
        <div id="banner-dots" class="absolute bottom-6 right-6 flex space-x-2 z-20"></div>
      </div>
    </div>
  </section>

  <!-- 4. ACTIVE CAMPAIGN HIGHLIGHT -->
  <div id="campaign-banner-section" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-4 mb-6"></div>

  <!-- 4.5. "তোমার অর্ডার চেক করো" (PROMINENT HOME SCREEN TRACKING CARD) -->
  <section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-2 mb-8">
    <div class="bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-900 rounded-3xl p-6 sm:p-8 shadow-xl text-white border border-indigo-800/40 relative overflow-hidden">
      <!-- Glow effect -->
      <div class="absolute -right-10 -bottom-10 w-64 h-64 bg-indigo-500/15 rounded-full blur-3xl pointer-events-none"></div>
      
      <div class="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
        <div class="max-w-xl">
          <div class="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 text-xs font-bold mb-2.5">
            <span>🚚</span>
            <span>লাইভ ডেলিভারি ট্র্যাকিং ও অর্ডার চেক</span>
          </div>
          <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center space-x-2">
            <span>তোমার অর্ডার চেক করো</span>
            <span class="text-xs font-semibold px-2.5 py-0.5 rounded-lg bg-indigo-600/60 text-indigo-100 uppercase tracking-wider">Live</span>
          </h2>
          <p class="text-xs sm:text-sm text-slate-300 mt-1.5 leading-relaxed">
            আপনার অর্ডার নম্বরটি (যেমন: <span class="text-amber-300 font-mono font-bold select-all">VEL-1001</span>) লিখে নিচে বোতামে চাপুন। মুহূর্তেই রিয়েল-টাইম ডেলিভারি স্ট্যাটাস ও COD ভেরিফিকেশন দেখতে পারবেন।
          </p>
        </div>

        <div class="w-full lg:max-w-md bg-white/10 backdrop-blur-md p-3 sm:p-4 rounded-2xl border border-white/15 shadow-inner">
          <form onsubmit="handleHomeOrderTrack(event)" class="flex flex-col sm:flex-row gap-2.5">
            <div class="relative flex-1">
              <input type="text" id="home-track-num" required placeholder="অর্ডার নম্বর লিখুন (e.g. VEL-1001)" 
                class="w-full px-4 py-3 bg-white text-slate-900 placeholder-slate-400 font-semibold rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-sm">
            </div>
            <button type="submit" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs sm:text-sm rounded-xl shadow-lg shadow-indigo-600/40 transition flex items-center justify-center space-x-2 whitespace-nowrap active:scale-95">
              <span>অর্ডার চেক করুন</span>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
            </button>
          </form>
          <div class="mt-3 px-1 flex items-center justify-between text-[11px] text-slate-300">
            <span class="flex items-center space-x-1">
              <span>📞</span>
              <span>সহায়তা: <strong class="text-white">01700-000000</strong></span>
            </span>
            <a href="/admin" class="text-amber-300 hover:text-white font-semibold underline flex items-center space-x-1">
              <span>👑</span>
              <span>অ্যাডমিন পোর্টাল</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 5. CATEGORIES PILLS & SHOWCASE -->
  <section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-xl sm:text-2xl font-black text-slate-950 tracking-tight">Explore Categories</h2>
        <p class="text-xs sm:text-sm text-slate-500 mt-0.5">Browse curated collections for your daily essentials</p>
      </div>
      <button onclick="filterByCategory('All')" class="text-xs font-bold text-indigo-600 hover:text-indigo-800 transition">View All</button>
    </div>

    <!-- Category Horizontal Scroll -->
    <div id="categories-container" class="flex space-x-4 overflow-x-auto pb-4 custom-scroll">
      <!-- Injected via JavaScript -->
    </div>
  </section>

  <!-- 6. PRODUCT CATALOG & FILTERS -->
  <section id="products" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1">
    
    <!-- Controls Header: Category Tabs, Price Filter & Sort -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-200">
      <div class="flex items-center space-x-2 overflow-x-auto pb-2 md:pb-0" id="filter-pills">
        <button onclick="filterByCategory('All')" class="cat-pill active-pill px-4 py-2 rounded-xl text-xs font-bold bg-slate-950 text-white shadow transition whitespace-nowrap">All Products</button>
      </div>

      <div class="flex items-center space-x-3 text-xs">
        <span class="text-slate-500 font-medium hidden sm:inline">Sort:</span>
        <select id="sort-select" onchange="handleSortChange(this.value)" class="px-3 py-2 bg-white border border-slate-200 rounded-xl font-semibold text-slate-700 focus:outline-none focus:border-indigo-600">
          <option value="newest">Newest Arrivals</option>
          <option value="price_asc">Price: Low to High (৳)</option>
          <option value="price_desc">Price: High to Low (৳)</option>
          <option value="name">Product Name (A-Z)</option>
        </select>
      </div>
    </div>

    <!-- Product Grid -->
    <div id="products-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6 pt-8">
      <!-- Injected via JS -->
      <div class="col-span-full py-16 text-center text-slate-400">Loading products catalog...</div>
    </div>
  </section>

  <!-- 7. STORE BENEFITS / TRUST BADGES -->
  <section class="bg-white border-t border-slate-200 py-12">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
        <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100">
          <div class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
          </div>
          <h3 class="text-sm font-bold text-slate-900">Cash on Delivery</h3>
          <p class="text-xs text-slate-500 mt-1">Pay with cash when package arrives at your doorstep</p>
        </div>
        <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100">
          <div class="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
          </div>
          <h3 class="text-sm font-bold text-slate-900">100% Authentic</h3>
          <p class="text-xs text-slate-500 mt-1">Directly sourced quality-tested original goods</p>
        </div>
        <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100">
          <div class="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
          </div>
          <h3 class="text-sm font-bold text-slate-900">7-Day Easy Returns</h3>
          <p class="text-xs text-slate-500 mt-1">Hassle-free replacement if damaged or mismatched</p>
        </div>
        <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100">
          <div class="w-12 h-12 rounded-2xl bg-sky-50 text-sky-600 flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
          </div>
          <h3 class="text-sm font-bold text-slate-900">Dedicated Support</h3>
          <p class="text-xs text-slate-500 mt-1">Friendly phone & WhatsApp assistance in Bangla</p>
        </div>
      </div>
    </div>
  </section>

  <!-- 8. FOOTER -->
  <footer class="bg-slate-950 text-slate-400 text-xs pt-16 pb-12 border-t border-slate-900">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
      <div class="space-y-3">
        <div class="flex items-center space-x-2">
          <div class="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-extrabold text-sm">
            V
          </div>
          <span class="text-xl font-black text-white tracking-tight">VELORA</span>
        </div>
        <p class="text-xs text-slate-400 leading-relaxed">
          VELORA is Bangladesh's premier single-vendor e-commerce platform offering premium lifestyle, electronics, and daily essentials with verified Cash on Delivery.
        </p>
        <p class="text-xs text-slate-400">
          📍 House 14, Road 7, Banani, Dhaka-1213, Bangladesh
        </p>
      </div>

      <div>
        <h4 class="text-sm font-bold text-white uppercase tracking-wider mb-3">Quick Navigation</h4>
        <ul class="space-y-2">
          <li><a href="/#products" class="hover:text-white transition">Catalog Showcase</a></li>
          <li><a href="/track-order" onclick="openTrackOrderModal(event)" class="hover:text-white transition">Track Your Order</a></li>
          <li><a href="/admin" target="_blank" class="text-indigo-400 hover:text-indigo-300 font-semibold transition">Store Owner Administration</a></li>
        </ul>
      </div>

      <div>
        <h4 class="text-sm font-bold text-white uppercase tracking-wider mb-3">Customer Service</h4>
        <ul class="space-y-2">
          <li>Hotline: <strong class="text-white">+880 1700-000000</strong></li>
          <li>Email: <span class="text-slate-300">support@velora.com.bd</span></li>
          <li>Hours: 9:00 AM – 10:00 PM (Daily)</li>
          <li>Cash on Delivery in 64 Districts</li>
        </ul>
      </div>

      <div>
        <h4 class="text-sm font-bold text-white uppercase tracking-wider mb-3">Payment & Delivery</h4>
        <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
          <p class="text-emerald-400 font-bold">✓ Cash on Delivery (COD)</p>
          <p class="text-[11px] text-slate-400">Inside Dhaka: ৳60 (24–48 hours)</p>
          <p class="text-[11px] text-slate-400">Outside Dhaka: ৳120 (48–72 hours)</p>
        </div>
      </div>
    </div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 border-t border-slate-900 text-center text-slate-400 flex flex-col sm:flex-row items-center justify-between text-xs">
      <p>© 2026 VELORA Bangladesh. All rights reserved.</p>
      <div class="mt-2 sm:mt-0 space-x-4">
        <span>Bangladeshi Taka (BDT / ৳)</span>
        <span>•</span>
        <span>Verified Secure Checkout</span>
      </div>
    </div>
  </footer>

  <!-- ============================================== -->
  <!-- MODALS & DRAWERS (SPA FRONTEND COMPONENTS)      -->
  <!-- ============================================== -->

  <!-- Toast Notification -->
  <div id="toast" class="fixed bottom-6 right-6 z-50 hidden px-5 py-3 rounded-2xl shadow-2xl text-xs sm:text-sm font-semibold flex items-center space-x-2 transition-all"></div>

  <!-- Shopping Cart Slide-over Drawer -->
  <div id="cart-drawer" class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm hidden justify-end transition-opacity">
    <div class="w-full max-w-md bg-white h-full shadow-2xl flex flex-col justify-between">
      
      <!-- Drawer Header -->
      <div class="p-5 border-b border-slate-100 flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <svg class="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
          <h3 class="text-base font-bold text-slate-900">Shopping Cart</h3>
          <span id="cart-item-count" class="text-xs bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded-full">0</span>
        </div>
        <button onclick="toggleCartDrawer()" class="p-2 text-slate-400 hover:text-slate-900 transition">✕</button>
      </div>

      <!-- Cart Items List -->
      <div id="cart-items-list" class="p-5 overflow-y-auto flex-1 space-y-4">
        <!-- Injected via JS -->
      </div>

      <!-- Drawer Footer & Calculations -->
      <div class="p-5 border-t border-slate-100 bg-slate-50 space-y-4">
        
        <!-- Coupon Input Box -->
        <div class="flex space-x-2">
          <input type="text" id="coupon-input" placeholder="Coupon Code (e.g. VELORA10)" class="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs uppercase font-mono focus:outline-none focus:border-indigo-600">
          <button onclick="applyCoupon()" id="coupon-btn" class="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold transition">Apply</button>
        </div>
        <div id="coupon-feedback" class="text-xs hidden"></div>

        <!-- Delivery Location selector -->
        <div>
          <label class="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Delivery Destination (COD)</label>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <button type="button" onclick="setDeliveryArea('inside_dhaka')" id="btn-del-dhaka" class="p-2.5 rounded-xl border-2 border-indigo-600 bg-indigo-50/50 font-bold text-indigo-900 text-left">
              <span>Inside Dhaka</span>
              <span class="block text-[10px] text-slate-500 font-normal">৳60 charge</span>
            </button>
            <button type="button" onclick="setDeliveryArea('outside_dhaka')" id="btn-del-outside" class="p-2.5 rounded-xl border border-slate-200 bg-white font-medium text-slate-700 text-left">
              <span>Outside Dhaka</span>
              <span class="block text-[10px] text-slate-500 font-normal">৳120 charge</span>
            </button>
          </div>
        </div>

        <!-- Totals summary -->
        <div class="space-y-1.5 text-xs text-slate-600 pt-2 border-t border-slate-200">
          <div class="flex justify-between">
            <span>Subtotal:</span>
            <span id="cart-subtotal" class="font-bold text-slate-900">৳0</span>
          </div>
          <div class="flex justify-between">
            <span>Delivery Fee:</span>
            <span id="cart-delivery" class="font-bold text-slate-900">৳60</span>
          </div>
          <div id="cart-discount-row" class="hidden flex justify-between text-emerald-600 font-bold">
            <span>Coupon Discount:</span>
            <span id="cart-discount">-৳0</span>
          </div>
          <div class="flex justify-between text-base font-black text-slate-950 pt-2 border-t border-slate-200">
            <span>Total Payable:</span>
            <span id="cart-total" class="text-indigo-600">৳0</span>
          </div>
        </div>

        <!-- Checkout Action Button -->
        <button onclick="openCheckoutModal()" id="btn-proceed-checkout" class="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-2xl shadow-lg shadow-indigo-600/30 transition flex items-center justify-center space-x-2">
          <span>Proceed to Checkout</span>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
        </button>
      </div>

    </div>
  </div>

  <!-- Cash on Delivery Checkout Modal -->
  <div id="checkout-modal" class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm hidden items-center justify-center p-4">
    <div class="bg-white rounded-3xl max-w-xl w-full max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
      <div class="p-6 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 class="text-lg font-black text-slate-950">Confirm Cash on Delivery</h3>
          <p class="text-xs text-slate-500">Provide shipping details to complete your order</p>
        </div>
        <button onclick="closeModal('checkout-modal')" class="text-slate-400 hover:text-slate-900 p-2">✕</button>
      </div>

      <form onsubmit="handlePlaceOrder(event)" class="p-6 overflow-y-auto space-y-4 text-xs sm:text-sm flex-1">
        <!-- COD Badge Notice -->
        <div class="p-3 bg-amber-50 border border-amber-200/80 rounded-2xl flex items-start space-x-3 text-xs text-amber-900">
          <svg class="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          <div>
            <strong class="font-bold">Payment Method: Cash on Delivery Only</strong>
            <p class="text-[11px] text-amber-800 mt-0.5">Pay in cash directly to the delivery courier when your order arrives. Please keep exact change ready.</p>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2">
            <label class="block text-xs font-bold text-slate-700 mb-1">Full Name *</label>
            <input type="text" id="chk-name" required placeholder="e.g. Rafiqul Islam" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">Phone Number (Required for COD) *</label>
            <input type="tel" id="chk-phone" required placeholder="017XXXXXXXX" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white font-mono">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">Email Address</label>
            <input type="email" id="chk-email" placeholder="for order receipts" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">City / District *</label>
            <select id="chk-city" onchange="updateCityDeliveryCharge(this.value)" required class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
              <option value="Dhaka">Dhaka (Inside Dhaka - ৳60)</option>
              <option value="Chittagong">Chittagong (৳120)</option>
              <option value="Sylhet">Sylhet (৳120)</option>
              <option value="Rajshahi">Rajshahi (৳120)</option>
              <option value="Khulna">Khulna (৳120)</option>
              <option value="Barishal">Barishal (৳120)</option>
              <option value="Rangpur">Rangpur (৳120)</option>
              <option value="Mymensingh">Mymensingh (৳120)</option>
              <option value="Comilla">Comilla (৳120)</option>
              <option value="Other">Other District (৳120)</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">Delivery Area / Thana</label>
            <input type="text" id="chk-area" placeholder="e.g. Dhanmondi, Gulshan, Halishahar..." class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
          </div>
          <div class="sm:col-span-2">
            <label class="block text-xs font-bold text-slate-700 mb-1">Full Delivery Address *</label>
            <textarea id="chk-address" required rows="2" placeholder="House number, road number, landmark..." class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white"></textarea>
          </div>
          <div class="sm:col-span-2">
            <label class="block text-xs font-bold text-slate-700 mb-1">Special Delivery Notes</label>
            <input type="text" id="chk-notes" placeholder="e.g. Please deliver after 3:00 PM or call before arriving" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
          </div>
        </div>

        <!-- Summary in Checkout -->
        <div class="bg-slate-50 p-4 rounded-2xl border border-slate-100 space-y-2 text-xs">
          <div class="flex justify-between"><span>Items Subtotal:</span><span id="chk-subtotal" class="font-bold">৳0</span></div>
          <div class="flex justify-between"><span>Delivery Charge:</span><span id="chk-delivery" class="font-bold">৳60</span></div>
          <div id="chk-discount-row" class="hidden flex justify-between text-emerald-600 font-bold"><span>Discount:</span><span id="chk-discount">-৳0</span></div>
          <div class="flex justify-between text-base font-extrabold text-slate-900 pt-2 border-t border-slate-200">
            <span>Total to Pay (Cash on Delivery):</span>
            <span id="chk-total" class="text-indigo-600">৳0</span>
          </div>
        </div>

        <button type="submit" id="btn-submit-order" class="w-full py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-sm rounded-2xl shadow-xl shadow-indigo-600/30 transition">
          Confirm & Place Order (৳ Cash on Delivery)
        </button>
      </form>
    </div>
  </div>

  <!-- Order Success Confirmation Modal -->
  <div id="order-success-modal" class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm hidden items-center justify-center p-4">
    <div class="bg-white rounded-3xl max-w-md w-full p-6 text-center space-y-5 shadow-2xl">
      <div class="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
      </div>
      <div>
        <span class="text-xs font-bold uppercase tracking-widest text-emerald-600">Order Successfully Placed</span>
        <h3 class="text-2xl font-black text-slate-950 mt-1">Thank You!</h3>
        <p class="text-xs text-slate-500 mt-1">Your order is registered with Cash on Delivery payment.</p>
      </div>

      <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100 text-left space-y-2 text-xs">
        <div class="flex justify-between">
          <span class="text-slate-500 font-semibold">Order Number:</span>
          <span id="success-order-number" class="font-mono font-bold text-indigo-600 text-sm"></span>
        </div>
        <div class="flex justify-between">
          <span class="text-slate-500 font-semibold">Payable on Delivery:</span>
          <span id="success-order-total" class="font-bold text-slate-900"></span>
        </div>
        <div class="flex justify-between">
          <span class="text-slate-500 font-semibold">Payment Method:</span>
          <span class="font-semibold text-emerald-600">Cash on Delivery</span>
        </div>
      </div>

      <p class="text-xs text-slate-500 text-left">
        Our verification representative will reach out to your phone number shortly to verify your delivery details before dispatching.
      </p>

      <div class="flex space-x-3">
        <button onclick="trackSuccessOrder()" class="flex-1 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition">
          Track Order
        </button>
        <button onclick="closeModal('order-success-modal')" class="px-5 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition">
          Continue Shopping
        </button>
      </div>
    </div>
  </div>

  <!-- Order Tracking Modal -->
  <div id="track-modal" class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm hidden items-center justify-center p-4">
    <div class="bg-white rounded-3xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
      <div class="p-6 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 class="text-lg font-black text-slate-950">Track Your Order</h3>
          <p class="text-xs text-slate-500">Real-time delivery status & timeline in Bangladesh</p>
        </div>
        <button onclick="closeModal('track-modal')" class="text-slate-400 hover:text-slate-900 p-2">✕</button>
      </div>

      <div class="p-6 overflow-y-auto space-y-6 flex-1 text-xs sm:text-sm">
        <!-- Search inputs -->
        <form onsubmit="handleTrackOrderSubmit(event)" class="flex flex-col sm:flex-row gap-2">
          <input type="text" id="track-input-order" required placeholder="Order # (e.g. VEL-20261021-XXXXXX)" class="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-mono text-xs focus:outline-none focus:border-indigo-600">
          <input type="tel" id="track-input-phone" placeholder="Phone (optional verification)" class="sm:w-44 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-indigo-600">
          <button type="submit" class="px-5 py-2.5 bg-slate-950 hover:bg-indigo-600 text-white font-bold rounded-xl text-xs transition">Track</button>
        </form>

        <!-- Tracking Results Container -->
        <div id="track-results" class="hidden space-y-6"></div>
      </div>
    </div>
  </div>

  <!-- Product Quick View Modal -->
  <div id="quickview-modal" class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm hidden items-center justify-center p-4">
    <div class="bg-white rounded-3xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
      <div class="p-4 border-b border-slate-100 flex justify-end">
        <button onclick="closeModal('quickview-modal')" class="text-slate-400 hover:text-slate-900 p-1">✕</button>
      </div>
      <div class="p-6 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-2 gap-6" id="quickview-content"></div>
    </div>
  </div>

  <!-- Customer Auth / Profile Modal -->
  <div id="auth-modal" class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm hidden items-center justify-center p-4">
    <div class="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl relative">
      <button onclick="closeModal('auth-modal')" class="absolute top-5 right-5 text-slate-400 hover:text-slate-900">✕</button>

      <!-- Customer Profile View (if logged in) -->
      <div id="auth-profile-view" class="hidden space-y-6">
        <div class="text-center">
          <div class="w-14 h-14 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto text-xl font-bold mb-2">
            <span id="prof-avatar">U</span>
          </div>
          <h3 id="prof-name" class="text-lg font-bold text-slate-900">Customer Name</h3>
          <p id="prof-email" class="text-xs text-slate-500"></p>
        </div>

        <div class="space-y-3 pt-2">
          <button onclick="viewCustomerOrderHistory()" class="w-full py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold text-left flex items-center justify-between transition">
            <span>📦 View My Orders History</span>
            <span class="text-slate-400">→</span>
          </button>
          <button onclick="handleCustomerLogout()" class="w-full py-2.5 px-4 bg-rose-50 text-rose-600 hover:bg-rose-100 rounded-xl text-xs font-semibold text-center transition">
            Sign Out
          </button>
        </div>
      </div>

      <!-- Login / Register Forms (if not logged in) -->
      <div id="auth-forms-view" class="space-y-5">
        <div class="grid grid-cols-2 p-1 bg-slate-100 rounded-xl">
          <button onclick="switchAuthTab('login')" id="btn-tab-login" class="py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-slate-900 transition">Log In</button>
          <button onclick="switchAuthTab('register')" id="btn-tab-register" class="py-2 text-xs font-bold rounded-lg text-slate-500 hover:text-slate-900 transition">Create Account</button>
        </div>

        <!-- Login Form -->
        <form id="form-customer-login" onsubmit="handleCustomerLogin(event)" class="space-y-4 text-xs">
          <div>
            <label class="block font-bold text-slate-700 mb-1">Email Address</label>
            <input type="email" id="login-cust-email" required placeholder="you@example.com" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">Password</label>
            <input type="password" id="login-cust-pass" required placeholder="••••••••" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600 focus:bg-white">
          </div>
          <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition">
            Sign In to VELORA
          </button>
        </form>

        <!-- Register Form -->
        <form id="form-customer-register" onsubmit="handleCustomerRegister(event)" class="hidden space-y-3 text-xs">
          <div>
            <label class="block font-bold text-slate-700 mb-1">Full Name *</label>
            <input type="text" id="reg-cust-name" required placeholder="Rafiqul Islam" class="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">Email Address *</label>
            <input type="email" id="reg-cust-email" required placeholder="you@example.com" class="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">Phone Number (Bangladesh)</label>
            <input type="tel" id="reg-cust-phone" placeholder="017XXXXXXXX" class="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">Password (min 6 chars) *</label>
            <input type="password" id="reg-cust-pass" required minlength="6" placeholder="••••••••" class="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-600">
          </div>
          <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition">
            Create Customer Account
          </button>
        </form>
      </div>

    </div>
  </div>

  <!-- Customer Order History Modal -->
  <div id="orders-history-modal" class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm hidden items-center justify-center p-4">
    <div class="bg-white rounded-3xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
      <div class="p-6 border-b border-slate-100 flex items-center justify-between">
        <h3 class="text-base font-bold text-slate-900">My Order History</h3>
        <button onclick="closeModal('orders-history-modal')" class="text-slate-400 hover:text-slate-900">✕</button>
      </div>
      <div id="orders-history-list" class="p-6 overflow-y-auto space-y-4 flex-1 text-xs">
        <p class="text-slate-500 text-center py-6">Loading past orders...</p>
      </div>
    </div>
  </div>

  <!-- ============================================== -->
  <!-- FRONTEND BROWSER JAVASCRIPT ENGINE             -->
  <!-- ============================================== -->
  <script>
    // Global Client State
    let cart = JSON.parse(localStorage.getItem('velora_cart') || '[]');
    let currentCustomer = null;
    let productsCatalog = [];
    let categoriesCatalog = [];
    let activeCategory = 'All';
    let deliveryArea = 'inside_dhaka';
    let deliveryCharge = 60;
    let appliedCouponData = null;
    let lastOrderNumber = null;

    // Toast Notification Helper
    function showToast(msg, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = 'fixed bottom-6 right-6 z-50 px-5 py-3 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center space-x-2 transition-all ' + 
        (isError ? 'bg-rose-600 text-white' : 'bg-slate-950 text-white');
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 3500);
    }

    function openModal(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('hidden');
        el.classList.add('flex');
      }
    }

    function closeModal(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('hidden');
        el.classList.remove('flex');
      }
    }

    function debounce(func, wait) {
      let timeout;
      return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    }

    // Initialize Application on Page Load
    window.addEventListener('DOMContentLoaded', async () => {
      await Promise.all([
        checkCustomerAuth(),
        loadStoreSettings(),
        loadBanners(),
        loadCampaigns(),
        loadCategories(),
        loadProducts()
      ]);
      updateCartUI();
    });

    // 1. Store Settings & Announcement
    async function loadStoreSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success && data.settings) {
          if (data.settings.announcementBar) {
            document.getElementById('announcement-text').textContent = data.settings.announcementBar;
          }
        }
      } catch (e) {}
    }

    // 2. Customer Auth State
    async function checkCustomerAuth() {
      try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.success && data.customer) {
          currentCustomer = data.customer;
          document.getElementById('user-display-name').textContent = currentCustomer.name.split(' ')[0];
          document.getElementById('chk-name').value = currentCustomer.name || '';
          document.getElementById('chk-phone').value = currentCustomer.phone || '';
          document.getElementById('chk-email').value = currentCustomer.email || '';
          document.getElementById('chk-address').value = currentCustomer.address || '';
          if (currentCustomer.city) document.getElementById('chk-city').value = currentCustomer.city;
        } else {
          currentCustomer = null;
          document.getElementById('user-display-name').textContent = 'Account';
        }
      } catch (e) {
        currentCustomer = null;
      }
    }

    function toggleAuthModal() {
      if (currentCustomer) {
        document.getElementById('auth-forms-view').classList.add('hidden');
        document.getElementById('auth-profile-view').classList.remove('hidden');
        document.getElementById('prof-name').textContent = currentCustomer.name;
        document.getElementById('prof-email').textContent = currentCustomer.email;
        document.getElementById('prof-avatar').textContent = currentCustomer.name.charAt(0).toUpperCase();
      } else {
        document.getElementById('auth-profile-view').classList.add('hidden');
        document.getElementById('auth-forms-view').classList.remove('hidden');
      }
      openModal('auth-modal');
    }

    function switchAuthTab(mode) {
      const isLogin = mode === 'login';
      document.getElementById('form-customer-login').classList.toggle('hidden', !isLogin);
      document.getElementById('form-customer-register').classList.toggle('hidden', isLogin);
      document.getElementById('btn-tab-login').className = isLogin 
        ? 'py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-slate-900 transition' 
        : 'py-2 text-xs font-bold rounded-lg text-slate-500 hover:text-slate-900 transition';
      document.getElementById('btn-tab-register').className = !isLogin 
        ? 'py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-slate-900 transition' 
        : 'py-2 text-xs font-bold rounded-lg text-slate-500 hover:text-slate-900 transition';
    }

    async function handleCustomerLogin(e) {
      e.preventDefault();
      const email = document.getElementById('login-cust-email').value;
      const password = document.getElementById('login-cust-pass').value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Welcome back, ' + data.customer.name + '!');
          closeModal('auth-modal');
          checkCustomerAuth();
        } else {
          showToast(data.error || 'Login failed', true);
        }
      } catch (err) {
        showToast('Login network error', true);
      }
    }

    async function handleCustomerRegister(e) {
      e.preventDefault();
      const payload = {
        name: document.getElementById('reg-cust-name').value,
        email: document.getElementById('reg-cust-email').value,
        phone: document.getElementById('reg-cust-phone').value,
        password: document.getElementById('reg-cust-pass').value
      };

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
          showToast('Account created successfully!');
          closeModal('auth-modal');
          checkCustomerAuth();
        } else {
          showToast(data.error || 'Registration failed', true);
        }
      } catch (err) {
        showToast('Registration error', true);
      }
    }

    async function handleCustomerLogout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      currentCustomer = null;
      document.getElementById('user-display-name').textContent = 'Account';
      closeModal('auth-modal');
      showToast('Logged out');
    }

    // 3. Hero Banners
    let bannersList = [];
    let currentBannerIdx = 0;
    async function loadBanners() {
      try {
        const res = await fetch('/api/banners');
        const data = await res.json();
        if (data.success && data.banners.length) {
          bannersList = data.banners;
          renderBannerSlide(0);
          setupBannerInterval();
        }
      } catch (e) {}
    }

    function renderBannerSlide(idx) {
      currentBannerIdx = idx;
      const b = bannersList[idx];
      if (!b) return;

      const container = document.getElementById('banner-container');
      container.innerHTML = \`
        <div class="relative w-full h-full min-h-[360px] sm:min-h-[480px] flex items-center">
          <img src="\${b.image}" class="absolute inset-0 w-full h-full object-cover opacity-40">
          <div class="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/80 to-transparent"></div>
          <div class="relative z-10 p-8 sm:p-16 max-w-2xl text-white space-y-4">
            <span class="px-3.5 py-1 rounded-full text-[11px] font-black tracking-widest uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-400/30">
              \${b.badge || 'PROMO'}
            </span>
            <h1 class="text-3xl sm:text-5xl font-extrabold tracking-tight leading-tight">
              \${b.title}
            </h1>
            <p class="text-xs sm:text-base text-slate-300 font-normal line-clamp-2">
              \${b.subtitle || ''}
            </p>
            <div class="pt-3">
              <a href="\${b.link || '#products'}" class="inline-flex items-center space-x-2 px-6 py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-xl shadow-indigo-600/30 transition transform hover:-translate-y-0.5">
                <span>\${b.buttonText || 'Shop Collection'}</span>
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
              </a>
            </div>
          </div>
        </div>
      \`;

      const dots = document.getElementById('banner-dots');
      dots.innerHTML = bannersList.map((_, i) => \`
        <button onclick="renderBannerSlide(\${i})" class="w-2.5 h-2.5 rounded-full transition \${i === idx ? 'bg-indigo-500 w-6' : 'bg-white/40'}"></button>
      \`).join('');
    }

    function setupBannerInterval() {
      setInterval(() => {
        if (bannersList.length > 1) {
          const next = (currentBannerIdx + 1) % bannersList.length;
          renderBannerSlide(next);
        }
      }, 6000);
    }

    // 4. Campaigns Highlight
    async function loadCampaigns() {
      try {
        const res = await fetch('/api/campaigns');
        const data = await res.json();
        const section = document.getElementById('campaign-banner-section');
        if (data.success && data.campaigns.length) {
          const c = data.campaigns[0];
          section.innerHTML = \`
            <div class="relative overflow-hidden rounded-2xl bg-gradient-to-r from-indigo-900 to-slate-900 text-white p-5 sm:p-6 shadow-md border border-indigo-800/40 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div class="flex items-center space-x-4">
                <div class="w-12 h-12 rounded-xl bg-indigo-500/30 flex items-center justify-center text-amber-300 text-2xl font-black">
                  ⚡
                </div>
                <div>
                  <div class="flex items-center space-x-2">
                    <span class="text-xs font-bold uppercase tracking-wider text-amber-300">Active Campaign</span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/30 text-indigo-200">Limited Time</span>
                  </div>
                  <h3 class="text-base sm:text-lg font-black text-white mt-0.5">\${c.name}</h3>
                  <p class="text-xs text-indigo-200">\${c.description}</p>
                </div>
              </div>
              <button onclick="filterByCategory('All')" class="px-5 py-2.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-black rounded-xl text-xs shadow-md transition whitespace-nowrap">
                Shop Campaign Deals
              </button>
            </div>
          \`;
        }
      } catch (e) {}
    }

    // 5. Categories
    async function loadCategories() {
      try {
        const res = await fetch('/api/categories');
        const data = await res.json();
        if (data.success) {
          categoriesCatalog = data.categories;
          
          // Render category cards
          const container = document.getElementById('categories-container');
          container.innerHTML = categoriesCatalog.map(cat => \`
            <button onclick="filterByCategory('\${cat.name}')" class="flex-shrink-0 group flex flex-col items-center p-3 rounded-2xl bg-white border border-slate-100 hover:border-indigo-200 hover:shadow-md transition text-center w-28 sm:w-32">
              <div class="w-16 h-16 rounded-xl overflow-hidden bg-slate-100 mb-2">
                <img src="\${cat.image}" class="w-full h-full object-cover group-hover:scale-110 transition duration-300">
              </div>
              <span class="text-xs font-bold text-slate-800 group-hover:text-indigo-600 transition truncate w-full">\${cat.name}</span>
            </button>
          \`).join('');

          // Render filter pills
          const pills = document.getElementById('filter-pills');
          pills.innerHTML = \`
            <button onclick="filterByCategory('All')" id="pill-all" class="cat-pill px-4 py-2 rounded-xl text-xs font-bold \${activeCategory === 'All' ? 'bg-slate-950 text-white' : 'bg-slate-100 text-slate-600'} transition whitespace-nowrap">All Products</button>
          \` + categoriesCatalog.map(cat => \`
            <button onclick="filterByCategory('\${cat.name}')" id="pill-\${cat.slug}" class="cat-pill px-4 py-2 rounded-xl text-xs font-bold \${activeCategory === cat.name ? 'bg-slate-950 text-white' : 'bg-slate-100 text-slate-600'} hover:bg-slate-200 transition whitespace-nowrap">\${cat.name}</button>
          \`).join('');
        }
      } catch (e) {}
    }

    function filterByCategory(cat) {
      activeCategory = cat;
      loadProducts();

      document.querySelectorAll('.cat-pill').forEach(btn => {
        btn.className = 'cat-pill px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 transition whitespace-nowrap';
      });
      const selected = document.getElementById('pill-' + (cat === 'All' ? 'all' : cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')));
      if (selected) {
        selected.className = 'cat-pill px-4 py-2 rounded-xl text-xs font-bold bg-slate-950 text-white transition whitespace-nowrap';
      }
    }

    // 6. Products Catalog
    let currentSort = 'newest';
    let currentSearchTerm = '';

    async function loadProducts() {
      const grid = document.getElementById('products-grid');
      grid.innerHTML = '<div class="col-span-full py-16 text-center text-slate-400">Updating catalog...</div>';

      try {
        let url = '/api/products?sort=' + encodeURIComponent(currentSort);
        if (activeCategory !== 'All') url += '&category=' + encodeURIComponent(activeCategory);
        if (currentSearchTerm) url += '&search=' + encodeURIComponent(currentSearchTerm);

        const res = await fetch(url);
        const data = await res.json();
        if (data.success) {
          productsCatalog = data.products;
          if (!productsCatalog.length) {
            grid.innerHTML = '<div class="col-span-full py-16 text-center text-slate-400">No products match your search or filter.</div>';
            return;
          }

          grid.innerHTML = productsCatalog.map(p => {
            const hasDiscount = p.originalPrice && p.originalPrice > p.price;
            const discountPct = hasDiscount ? Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100) : 0;

            return \`
              <div class="bg-white rounded-3xl p-3 sm:p-4 border border-slate-100 hover:border-slate-200 shadow-sm hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300 flex flex-col justify-between group">
                <div class="relative rounded-2xl overflow-hidden bg-slate-50 aspect-square mb-3 cursor-pointer" onclick="openQuickView('\${p.slug}')">
                  <img src="\${(p.images && p.images[0]) || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600'}" 
                    class="w-full h-full object-cover group-hover:scale-105 transition duration-500">
                  \${discountPct > 0 ? \`
                    <span class="absolute top-2 left-2 px-2.5 py-1 rounded-xl text-[10px] font-black bg-rose-600 text-white shadow">
                      -\${discountPct}%
                    </span>
                  \` : ''}
                  \${p.stock <= 5 ? \`
                    <span class="absolute bottom-2 left-2 px-2 py-0.5 rounded-lg text-[9px] font-bold bg-amber-500/90 text-white backdrop-blur-sm">
                      Only \${p.stock} left
                    </span>
                  \` : ''}
                </div>

                <div class="flex-1 flex flex-col justify-between">
                  <div>
                    <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">\${p.category}</span>
                    <h3 class="text-xs sm:text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition line-clamp-2 cursor-pointer" onclick="openQuickView('\${p.slug}')">
                      \${p.name}
                    </h3>
                  </div>

                  <div class="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <div>
                      <div class="text-sm sm:text-base font-black text-slate-950">৳\${Number(p.price).toLocaleString()}</div>
                      \${hasDiscount ? \`
                        <div class="text-[11px] text-slate-400 line-through">৳\${Number(p.originalPrice).toLocaleString()}</div>
                      \` : ''}
                    </div>

                    <button onclick="addToCart('\${p._id}')" class="p-2 sm:px-3 sm:py-2 bg-slate-950 hover:bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-md transition flex items-center space-x-1">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                      <span class="hidden sm:inline">Add</span>
                    </button>
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        }
      } catch (err) {
        grid.innerHTML = '<div class="col-span-full py-16 text-center text-rose-500">Error loading catalog.</div>';
      }
    }

    function handleSearch() {
      currentSearchTerm = document.getElementById('store-search').value;
      loadProducts();
    }

    function handleMobileSearch() {
      currentSearchTerm = document.getElementById('mobile-search').value;
      loadProducts();
    }

    function handleSortChange(val) {
      currentSort = val;
      loadProducts();
    }

    // 7. Shopping Cart Logic
    function toggleCartDrawer() {
      const drawer = document.getElementById('cart-drawer');
      const isHidden = drawer.classList.contains('hidden');
      if (isHidden) {
        drawer.classList.remove('hidden');
        drawer.classList.add('flex');
      } else {
        drawer.classList.add('hidden');
        drawer.classList.remove('flex');
      }
    }

    function saveCart() {
      localStorage.setItem('velora_cart', JSON.stringify(cart));
      updateCartUI();
    }

    function addToCart(productId, qty = 1, selectedSize = '', selectedColor = '') {
      const product = productsCatalog.find(p => p._id === productId);
      if (!product) return;

      const existing = cart.find(item => item.productId === productId && item.selectedSize === selectedSize && item.selectedColor === selectedColor);
      if (existing) {
        if (existing.quantity + qty > product.stock) {
          showToast('Cannot add more than available stock (' + product.stock + ')', true);
          return;
        }
        existing.quantity += qty;
      } else {
        if (qty > product.stock) {
          showToast('Only ' + product.stock + ' items in stock', true);
          return;
        }
        cart.push({
          productId: product._id,
          name: product.name,
          slug: product.slug,
          price: product.price,
          image: (product.images && product.images[0]) || '',
          quantity: qty,
          selectedSize,
          selectedColor,
          stock: product.stock
        });
      }

      saveCart();
      showToast('Added "' + product.name + '" to cart!');
    }

    function updateCartItemQty(idx, change) {
      if (!cart[idx]) return;
      const newQty = cart[idx].quantity + change;
      if (newQty <= 0) {
        cart.splice(idx, 1);
      } else {
        if (newQty > cart[idx].stock) {
          showToast('Max stock limit reached (' + cart[idx].stock + ')', true);
          return;
        }
        cart[idx].quantity = newQty;
      }
      saveCart();
    }

    function removeCartItem(idx) {
      cart.splice(idx, 1);
      saveCart();
    }

    function setDeliveryArea(area) {
      deliveryArea = area;
      deliveryCharge = area === 'outside_dhaka' ? 120 : 60;
      
      const btnDhaka = document.getElementById('btn-del-dhaka');
      const btnOutside = document.getElementById('btn-del-outside');
      
      if (area === 'inside_dhaka') {
        btnDhaka.className = 'p-2.5 rounded-xl border-2 border-indigo-600 bg-indigo-50/50 font-bold text-indigo-900 text-left';
        btnOutside.className = 'p-2.5 rounded-xl border border-slate-200 bg-white font-medium text-slate-700 text-left';
      } else {
        btnOutside.className = 'p-2.5 rounded-xl border-2 border-indigo-600 bg-indigo-50/50 font-bold text-indigo-900 text-left';
        btnDhaka.className = 'p-2.5 rounded-xl border border-slate-200 bg-white font-medium text-slate-700 text-left';
      }

      updateCartUI();
    }

    function updateCartUI() {
      const badge = document.getElementById('cart-badge');
      const itemCount = document.getElementById('cart-item-count');
      const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
      badge.textContent = totalItems;
      itemCount.textContent = totalItems;

      const list = document.getElementById('cart-items-list');
      if (!cart.length) {
        list.innerHTML = \`
          <div class="h-full flex flex-col items-center justify-center text-center p-8 text-slate-400">
            <svg class="w-16 h-16 text-slate-200 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
            <p class="font-bold text-slate-800 text-sm">Your shopping cart is empty</p>
            <p class="text-xs text-slate-400 mt-1">Browse our products and add your favorite items</p>
          </div>
        \`;
        document.getElementById('cart-subtotal').textContent = '৳0';
        document.getElementById('cart-delivery').textContent = '৳0';
        document.getElementById('cart-total').textContent = '৳0';
        document.getElementById('btn-proceed-checkout').disabled = true;
        document.getElementById('btn-proceed-checkout').classList.add('opacity-50', 'cursor-not-allowed');
        return;
      }

      document.getElementById('btn-proceed-checkout').disabled = false;
      document.getElementById('btn-proceed-checkout').classList.remove('opacity-50', 'cursor-not-allowed');

      list.innerHTML = cart.map((item, idx) => \`
        <div class="flex items-center space-x-3 p-3 rounded-2xl bg-slate-50 border border-slate-100">
          <img src="\${item.image}" class="w-16 h-16 rounded-xl object-cover bg-white border border-slate-200">
          <div class="flex-1 min-w-0">
            <h4 class="text-xs font-bold text-slate-900 truncate">\${item.name}</h4>
            \${item.selectedSize ? '<span class="text-[10px] text-slate-500">Size: ' + item.selectedSize + '</span>' : ''}
            <div class="text-xs font-extrabold text-slate-900 mt-1">৳\${Number(item.price).toLocaleString()}</div>
          </div>
          <div class="flex items-center space-x-1.5">
            <button onclick="updateCartItemQty(\${idx}, -1)" class="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-700 font-bold flex items-center justify-center hover:bg-slate-100">-</button>
            <span class="w-6 text-center text-xs font-bold text-slate-900">\${item.quantity}</span>
            <button onclick="updateCartItemQty(\${idx}, 1)" class="w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-700 font-bold flex items-center justify-center hover:bg-slate-100">+</button>
          </div>
          <button onclick="removeCartItem(\${idx})" class="p-1.5 text-slate-400 hover:text-rose-600 transition">✕</button>
        </div>
      \`).join('');

      const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      let effectiveDelivery = subtotal >= 2500 ? 0 : deliveryCharge;

      let discount = 0;
      if (appliedCouponData) {
        discount = appliedCouponData.discountAmount || 0;
      }

      const total = Math.max(0, subtotal + effectiveDelivery - discount);

      document.getElementById('cart-subtotal').textContent = '৳' + subtotal.toLocaleString();
      document.getElementById('cart-delivery').textContent = effectiveDelivery === 0 ? 'FREE' : '৳' + effectiveDelivery.toLocaleString();
      
      const discountRow = document.getElementById('cart-discount-row');
      if (discount > 0) {
        discountRow.classList.remove('hidden');
        document.getElementById('cart-discount').textContent = '-৳' + discount.toLocaleString();
      } else {
        discountRow.classList.add('hidden');
      }

      document.getElementById('cart-total').textContent = '৳' + total.toLocaleString();
    }

    async function applyCoupon() {
      const code = document.getElementById('coupon-input').value.trim();
      if (!code) return;

      const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const feedback = document.getElementById('coupon-feedback');
      const btn = document.getElementById('coupon-btn');
      btn.disabled = true;

      try {
        const res = await fetch('/api/coupons/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, cartSubtotal: subtotal, items: cart })
        });
        const data = await res.json();
        if (data.success) {
          appliedCouponData = data.coupon;
          feedback.textContent = '✓ ' + data.message;
          feedback.className = 'text-xs text-emerald-600 font-bold block mt-1';
          showToast(data.message);
          updateCartUI();
        } else {
          appliedCouponData = null;
          feedback.textContent = '✕ ' + (data.error || 'Invalid coupon');
          feedback.className = 'text-xs text-rose-600 font-bold block mt-1';
          updateCartUI();
        }
      } catch (err) {
        feedback.textContent = '✕ Network error validating coupon';
        feedback.className = 'text-xs text-rose-600 font-bold block mt-1';
      } finally {
        btn.disabled = false;
      }
    }

    // 8. Checkout Flow
    function openCheckoutModal() {
      if (!cart.length) return;
      toggleCartDrawer();

      const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      let effectiveDelivery = subtotal >= 2500 ? 0 : deliveryCharge;
      let discount = appliedCouponData ? (appliedCouponData.discountAmount || 0) : 0;
      const total = Math.max(0, subtotal + effectiveDelivery - discount);

      document.getElementById('chk-subtotal').textContent = '৳' + subtotal.toLocaleString();
      document.getElementById('chk-delivery').textContent = effectiveDelivery === 0 ? 'FREE' : '৳' + effectiveDelivery.toLocaleString();
      
      const discRow = document.getElementById('chk-discount-row');
      if (discount > 0) {
        discRow.classList.remove('hidden');
        document.getElementById('chk-discount').textContent = '-৳' + discount.toLocaleString();
      } else {
        discRow.classList.add('hidden');
      }

      document.getElementById('chk-total').textContent = '৳' + total.toLocaleString();
      openModal('checkout-modal');
    }

    function updateCityDeliveryCharge(city) {
      if (city === 'Dhaka') {
        setDeliveryArea('inside_dhaka');
      } else {
        setDeliveryArea('outside_dhaka');
      }
      openCheckoutModal(); // refresh displayed numbers
    }

    async function handlePlaceOrder(e) {
      e.preventDefault();
      const btn = document.getElementById('btn-submit-order');
      btn.disabled = true;
      btn.textContent = 'Processing Cash on Delivery Order...';

      const payload = {
        customerInfo: {
          name: document.getElementById('chk-name').value,
          phone: document.getElementById('chk-phone').value,
          email: document.getElementById('chk-email').value,
          city: document.getElementById('chk-city').value,
          address: document.getElementById('chk-address').value + (document.getElementById('chk-area').value ? ', ' + document.getElementById('chk-area').value : ''),
          deliveryNotes: document.getElementById('chk-notes').value
        },
        items: cart,
        couponCode: appliedCouponData ? appliedCouponData.code : null,
        deliveryArea
      };

      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
          lastOrderNumber = data.orderNumber;
          cart = [];
          appliedCouponData = null;
          saveCart();
          closeModal('checkout-modal');

          document.getElementById('success-order-number').textContent = data.orderNumber;
          document.getElementById('success-order-total').textContent = '৳' + Number(data.order.finalAmount).toLocaleString();
          openModal('order-success-modal');
        } else {
          showToast(data.error || 'Failed to place order', true);
        }
      } catch (err) {
        showToast('Network error placing order', true);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm & Place Order (৳ Cash on Delivery)';
      }
    }

    function trackSuccessOrder() {
      closeModal('order-success-modal');
      if (lastOrderNumber) {
        document.getElementById('track-input-order').value = lastOrderNumber;
        openModal('track-modal');
        handleTrackOrderSubmit(new Event('submit'));
      }
    }

    // 9. Order Tracking View
    function openTrackOrderModal(e) {
      if (e) e.preventDefault();
      openModal('track-modal');
    }

    function handleHomeOrderTrack(e) {
      if (e) e.preventDefault();
      const input = document.getElementById('home-track-num');
      const val = input ? input.value.trim() : '';
      if (!val) {
        showToast('অনুগ্রহ করে আপনার অর্ডার নম্বরটি লিখুন', true);
        return;
      }
      const trackModalInput = document.getElementById('track-input-order');
      if (trackModalInput) {
        trackModalInput.value = val;
      }
      openModal('track-modal');
      handleTrackOrderSubmit(null);
    }

    // Three-Dot (•••) Menu Functions
    function toggleThreeDotMenu(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const menu = document.getElementById('three-dot-dropdown');
      if (menu) {
        menu.classList.toggle('hidden');
      }
    }

    function closeThreeDotMenu() {
      const menu = document.getElementById('three-dot-dropdown');
      if (menu) menu.classList.add('hidden');
    }

    document.addEventListener('click', (e) => {
      const btn = document.getElementById('btn-three-dot');
      const menu = document.getElementById('three-dot-dropdown');
      if (menu && !menu.classList.contains('hidden')) {
        if (btn && !btn.contains(e.target) && !menu.contains(e.target)) {
          menu.classList.add('hidden');
        }
      }
    });

    async function handleTrackOrderSubmit(e) {
      if (e) e.preventDefault();
      const orderNum = document.getElementById('track-input-order').value.trim();
      const phone = document.getElementById('track-input-phone').value.trim();
      if (!orderNum) return;

      const container = document.getElementById('track-results');
      container.classList.remove('hidden');
      container.innerHTML = '<p class="text-slate-400 text-center py-6">Locating order in system...</p>';

      try {
        const res = await fetch('/api/orders/' + encodeURIComponent(orderNum) + '?phone=' + encodeURIComponent(phone));
        const data = await res.json();
        if (data.success && data.order) {
          const o = data.order;
          
          const statusSteps = ['Pending Confirmation', 'Confirmed', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered'];
          const currentStepIdx = statusSteps.indexOf(o.orderStatus);

          container.innerHTML = \`
            <div class="p-5 rounded-2xl bg-slate-50 border border-slate-100 space-y-4">
              <div class="flex items-start justify-between">
                <div>
                  <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Order Reference</span>
                  <h4 class="text-base font-black text-indigo-600 font-mono">#\${o.orderNumber}</h4>
                  <span class="text-xs text-slate-500">Placed: \${new Date(o.createdAt).toLocaleDateString()}</span>
                </div>
                <span class="px-3 py-1 rounded-full text-xs font-black \${o.orderStatus === 'Cancelled' ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'}">
                  \${o.orderStatus}
                </span>
              </div>

              <!-- Visual Status Progress Bar -->
              \${o.orderStatus !== 'Cancelled' ? \`
                <div class="pt-4 pb-2">
                  <div class="flex items-center justify-between text-[10px] font-bold text-slate-500 mb-2">
                    <span class="\${currentStepIdx >= 0 ? 'text-indigo-600 font-extrabold' : ''}">Pending</span>
                    <span class="\${currentStepIdx >= 1 ? 'text-indigo-600 font-extrabold' : ''}">Confirmed</span>
                    <span class="\${currentStepIdx >= 2 ? 'text-indigo-600 font-extrabold' : ''}">Processing</span>
                    <span class="\${currentStepIdx >= 3 ? 'text-indigo-600 font-extrabold' : ''}">Shipped</span>
                    <span class="\${currentStepIdx >= 5 ? 'text-emerald-600 font-extrabold' : ''}">Delivered</span>
                  </div>
                  <div class="h-2 rounded-full bg-slate-200 overflow-hidden flex">
                    <div class="h-full bg-indigo-600 transition-all duration-500" style="width: \${Math.max(10, ((currentStepIdx + 1) / statusSteps.length) * 100)}%"></div>
                  </div>
                </div>
              \` : '<div class="p-3 bg-rose-50 text-rose-700 font-bold rounded-xl text-xs">This order has been cancelled.</div>'}

              <!-- Payment details -->
              <div class="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-slate-200">
                <div>
                  <span class="text-slate-500 block">Payment Method:</span>
                  <span class="font-bold text-slate-900">\${o.paymentMethod}</span>
                </div>
                <div>
                  <span class="text-slate-500 block">Payment Status:</span>
                  <span class="font-bold \${o.paymentStatus === 'Paid on Delivery' ? 'text-emerald-600' : 'text-amber-600'}">\${o.paymentStatus}</span>
                </div>
                <div>
                  <span class="text-slate-500 block">Recipient:</span>
                  <span class="font-semibold text-slate-800">\${o.customerInfo.name}</span>
                </div>
                <div>
                  <span class="text-slate-500 block">Payable Total:</span>
                  <span class="font-black text-indigo-600 text-sm">৳\${Number(o.finalAmount).toLocaleString()}</span>
                </div>
              </div>

              <!-- Items list -->
              <div class="pt-2 border-t border-slate-200">
                <span class="text-[11px] font-bold uppercase text-slate-400 block mb-2">Purchased Items</span>
                <div class="space-y-1.5">
                  \${(o.items || []).map(i => \`
                    <div class="flex justify-between text-xs text-slate-700">
                      <span>\${i.quantity}x \${i.name}</span>
                      <span class="font-bold text-slate-900">৳\${Number(i.price * i.quantity).toLocaleString()}</span>
                    </div>
                  \`).join('')}
                </div>
              </div>

              <!-- Eligible Cancel Button -->
              \${o.orderStatus === 'Pending Confirmation' && currentCustomer ? \`
                <div class="pt-2 border-t border-slate-200 text-right">
                  <button onclick="cancelCustomerOrder('\${o.orderNumber}')" class="px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold rounded-xl text-xs transition">
                    Request Order Cancellation
                  </button>
                </div>
              \` : ''}
            </div>
          \`;
        } else {
          container.innerHTML = '<p class="text-rose-500 text-center py-6 font-bold">' + (data.error || 'Order not found') + '</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-rose-500 text-center py-6">Failed to retrieve tracking info</p>';
      }
    }

    async function cancelCustomerOrder(orderNumber) {
      if (!confirm('Are you sure you want to cancel order #' + orderNumber + '?')) return;
      try {
        const res = await fetch('/api/orders/' + orderNumber + '/cancel', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Order cancelled successfully');
          handleTrackOrderSubmit(null);
        } else {
          showToast(data.error || 'Cancellation failed', true);
        }
      } catch (err) {
        showToast('Error cancelling order', true);
      }
    }

    // 10. Customer Order History
    async function viewCustomerOrderHistory() {
      closeModal('auth-modal');
      openModal('orders-history-modal');
      const container = document.getElementById('orders-history-list');
      container.innerHTML = '<p class="text-slate-400 text-center py-6">Loading past orders...</p>';

      try {
        const res = await fetch('/api/account/orders');
        const data = await res.json();
        if (data.success && data.orders.length) {
          container.innerHTML = data.orders.map(o => \`
            <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100 space-y-2">
              <div class="flex justify-between items-center">
                <span class="font-mono font-bold text-indigo-600 text-sm">#\${o.orderNumber}</span>
                <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-800">\${o.orderStatus}</span>
              </div>
              <div class="text-xs text-slate-500">\${new Date(o.createdAt).toLocaleDateString()} • \${o.items?.length || 0} item(s)</div>
              <div class="flex justify-between items-center pt-2 border-t border-slate-200">
                <span class="font-bold text-slate-900">৳\${Number(o.finalAmount).toLocaleString()}</span>
                <button onclick="quickTrackFromHistory('\${o.orderNumber}')" class="text-indigo-600 font-bold hover:underline">Track Status →</button>
              </div>
            </div>
          \`).join('');
        } else {
          container.innerHTML = '<p class="text-slate-400 text-center py-6">You have not placed any orders yet.</p>';
        }
      } catch (e) {
        container.innerHTML = '<p class="text-rose-500 text-center py-6">Failed to load order history.</p>';
      }
    }

    function quickTrackFromHistory(orderNum) {
      closeModal('orders-history-modal');
      document.getElementById('track-input-order').value = orderNum;
      openModal('track-modal');
      handleTrackOrderSubmit(null);
    }

    // 11. Product Quick View
    function openQuickView(slug) {
      const p = productsCatalog.find(item => item.slug === slug);
      if (!p) return;

      const modalContent = document.getElementById('quickview-content');
      modalContent.innerHTML = \`
        <div class="rounded-2xl overflow-hidden bg-slate-50 aspect-square">
          <img src="\${(p.images && p.images[0]) || ''}" class="w-full h-full object-cover">
        </div>
        <div class="flex flex-col justify-between space-y-4">
          <div>
            <span class="text-xs font-bold text-indigo-600 uppercase tracking-wider">\${p.category}</span>
            <h3 class="text-xl font-extrabold text-slate-900 mt-1">\${p.name}</h3>
            <p class="text-xs text-slate-500 mt-2 leading-relaxed">\${p.description}</p>
          </div>

          <div class="space-y-3 pt-4 border-t border-slate-100">
            <div class="flex items-baseline space-x-3">
              <span class="text-2xl font-black text-slate-950">৳\${Number(p.price).toLocaleString()}</span>
              \${p.originalPrice && p.originalPrice > p.price ? '<span class="text-sm text-slate-400 line-through">৳' + Number(p.originalPrice).toLocaleString() + '</span>' : ''}
            </div>

            <div class="text-xs text-slate-500 font-semibold">
              Availability: \${p.stock > 0 ? '<span class="text-emerald-600 font-bold">In Stock (' + p.stock + ' units)</span>' : '<span class="text-rose-600">Out of Stock</span>'}
            </div>

            <div class="flex space-x-3 pt-2">
              <button onclick="addToCart('\${p._id}'); closeModal('quickview-modal');" class="flex-1 py-3.5 bg-slate-950 hover:bg-slate-800 text-white rounded-2xl font-bold text-xs transition">
                Add to Cart
              </button>
              <button onclick="buyNow('\${p._id}')" class="flex-1 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-bold text-xs shadow-lg shadow-indigo-600/30 transition">
                Buy Now (COD)
              </button>
            </div>
          </div>
        </div>
      \`;
      openModal('quickview-modal');
    }

    function buyNow(productId) {
      closeModal('quickview-modal');
      addToCart(productId, 1);
      openCheckoutModal();
    }
  </script>
</body>
</html>`;
}

// ----------------------------------------------------
// Server Startup & Vercel Serverless Export
// ----------------------------------------------------
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 VELORA Server running on http://localhost:${PORT}`);
    console.log(`📦 Admin Dashboard available at http://localhost:${PORT}/admin`);
  });
}

export default app;
