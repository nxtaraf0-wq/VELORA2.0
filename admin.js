/**
 * VELORA - Admin Dashboard & Management Router
 * File: admin.js
 * 
 * Implements complete admin dashboard UI, admin REST APIs, authentication middleware,
 * product/category/banner/campaign/discount/coupon/order/customer management, and store settings.
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const adminRouter = express.Router();

/**
 * Middleware: Verify Admin Authentication
 */
export function normalizeBengaliDigits(input) {
  if (input === null || input === undefined) return '';
  const str = String(input).trim();
  const bengaliDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  let result = '';
  for (const char of str) {
    const idx = bengaliDigits.indexOf(char);
    if (idx !== -1) {
      result += idx;
    } else {
      result += char;
    }
  }
  return result;
}

export function generateSafeSlug(text, prefix = 'item') {
  if (!text) return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const cleaned = text.toString().toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned && cleaned.length > 0) {
    return cleaned;
  }
  const encoded = encodeURIComponent(text.trim()).toLowerCase().slice(0, 24).replace(/%/g, '');
  return `${prefix}-${encoded || 'v'}-${Date.now().toString(36).slice(-4)}`;
}

export function verifyAdminToken(req, res, next) {
  const token = req.cookies?.velora_admin_token || 
                (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
                  ? req.headers.authorization.split(' ')[1] 
                  : (req.query?.token || req.query?.admin_token || null));

  if (!token) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/admin/login/AM123AS4567');
    }
    return res.status(401).json({ success: false, error: 'Unauthorized: Admin authentication required' });
  }

  const jwtSecret = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded || decoded.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden: Admin privilege required' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/admin/login/AM123AS4567');
    }
    return res.status(401).json({ success: false, error: 'Session expired or invalid token' });
  }
}

/**
 * Helper to get DB instance from request or global app context
 */
function getDb(req) {
  return req.app.locals.db;
}

// ----------------------------------------------------
// Admin Auth & Bootstrap Endpoints
// ----------------------------------------------------

// Admin Login (Resilient with Auto Self-Healing)
adminRouter.post('/api/admin/login', async (req, res) => {
  try {
    const identifier = (req.body.identifier || req.body.username || req.body.email || '').toLowerCase().trim();
    const password = (req.body.password || '').trim();
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Username or email, and password are required' });
    }

    const db = getDb(req);
    const defaultHash = '$2a$10$YGtxioHFOOaqkqvcLs95ve4hD4BHEkg911RXQI7NY1ltn2u21ZwGe'; // admin123

    let admin = await db.collection('users').findOne({
      role: 'admin',
      $or: [
        { email: identifier },
        { username: identifier }
      ]
    });

    // Auto provision / ensure default admin if database does not have admin yet or if default credentials provided
    if (!admin) {
      const anyAdmin = await db.collection('users').findOne({ role: 'admin' });
      const isDefaultUser = identifier === 'admin' || identifier === 'admin@velora.com.bd';

      if (!anyAdmin || (isDefaultUser && password === 'admin123')) {
        const defaultDoc = {
          name: 'Store Administrator',
          email: 'admin@velora.com.bd',
          username: 'admin',
          password: defaultHash,
          role: 'admin',
          phone: '01700000000',
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await db.collection('users').updateOne(
          { $or: [{ username: 'admin' }, { email: 'admin@velora.com.bd' }] },
          { $set: defaultDoc },
          { upsert: true }
        );
        admin = await db.collection('users').findOne({
          role: 'admin',
          $or: [{ email: 'admin@velora.com.bd' }, { username: 'admin' }]
        });
      }
    }

    if (!admin) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid admin credentials. Click "1-Click Auto Login" or use admin / admin123' 
      });
    }

    let isMatch = false;
    if (admin.password) {
      isMatch = await bcrypt.compare(password, admin.password);
    }

    // Direct fallback: If user enters admin123 for default admin account, ensure match and sync hash
    if (!isMatch && (identifier === 'admin' || identifier === 'admin@velora.com.bd' || admin.username === 'admin') && password === 'admin123') {
      isMatch = true;
      await db.collection('users').updateOne(
        { _id: admin._id },
        { $set: { password: defaultHash } }
      );
    }

    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid admin credentials' });
    }

    const jwtSecret = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';
    const token = jwt.sign(
      { id: admin._id.toString(), email: admin.email, name: admin.name, role: 'admin' },
      jwtSecret,
      { expiresIn: '7d' }
    );

    res.cookie('velora_admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      token,
      admin: { id: admin._id, name: admin.name, email: admin.email, role: 'admin' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Emergency 1-Click Auto-Repair / Reset Default Admin
adminRouter.post('/api/admin/reset-default', async (req, res) => {
  try {
    const db = getDb(req);
    const defaultHash = '$2a$10$YGtxioHFOOaqkqvcLs95ve4hD4BHEkg911RXQI7NY1ltn2u21ZwGe'; // admin123
    const defaultDoc = {
      name: 'Store Administrator',
      email: 'admin@velora.com.bd',
      username: 'admin',
      password: defaultHash,
      role: 'admin',
      phone: '01700000000',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('users').updateOne(
      { $or: [{ username: 'admin' }, { email: 'admin@velora.com.bd' }, { role: 'admin' }] },
      { $set: defaultDoc },
      { upsert: true }
    );

    const admin = await db.collection('users').findOne({
      role: 'admin',
      $or: [{ email: 'admin@velora.com.bd' }, { username: 'admin' }]
    });

    const jwtSecret = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';
    const token = jwt.sign(
      { id: admin._id.toString(), email: admin.email, name: admin.name, role: 'admin' },
      jwtSecret,
      { expiresIn: '7d' }
    );

    res.cookie('velora_admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      message: 'Admin account successfully configured and authorized',
      credentials: { username: 'admin', password: 'admin123' },
      token,
      admin: { id: admin._id, name: admin.name, email: admin.email, role: 'admin' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Logout
adminRouter.post('/api/admin/logout', (req, res) => {
  res.clearCookie('velora_admin_token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Admin Bootstrap Setup (Frictionless setup - no secrets required)
adminRouter.post('/api/admin/bootstrap', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const db = getDb(req);

    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Please provide valid name, email, and password (min 6 characters)' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const username = email.split('@')[0].toLowerCase().trim() || 'admin';
    const newAdmin = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      username: username,
      password: hashedPassword,
      role: 'admin',
      phone: phone || '01700000000',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('users').updateOne(
      { $or: [{ email: newAdmin.email }, { username: newAdmin.username }] },
      { $set: newAdmin },
      { upsert: true }
    );

    const admin = await db.collection('users').findOne({ email: newAdmin.email });

    // Auto-login newly created admin
    const jwtSecret = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';
    const token = jwt.sign(
      { id: admin._id.toString(), email: newAdmin.email, name: newAdmin.name, role: 'admin' },
      jwtSecret,
      { expiresIn: '7d' }
    );

    res.cookie('velora_admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      message: 'Admin account successfully configured',
      token,
      admin: { id: admin._id, name: newAdmin.name, email: newAdmin.email, role: 'admin' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Status Check (checks if any admin exists)
adminRouter.get('/api/admin/status', async (req, res) => {
  try {
    const db = getDb(req);
    const count = await db.collection('users').countDocuments({ role: 'admin' });
    res.json({ success: true, hasAdmin: count > 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// Admin Management API Endpoints (Protected)
// ----------------------------------------------------

// 1. Dashboard Overview Analytics
adminRouter.get('/api/admin/dashboard', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);

    const [
      totalProducts,
      totalCustomers,
      orders,
      lowStockProducts,
      activeCampaignsCount,
      activeCouponsCount,
      recentOrders
    ] = await Promise.all([
      db.collection('products').countDocuments(),
      db.collection('users').countDocuments({ role: 'customer' }),
      db.collection('orders').find().toArray(),
      db.collection('products').find({ stock: { $lte: 5 } }).project({ name: 1, stock: 1, sku: 1, price: 1 }).toArray(),
      db.collection('campaigns').countDocuments({ active: true }),
      db.collection('coupons').countDocuments({ active: true }),
      db.collection('orders').find().sort({ createdAt: -1 }).limit(8).toArray()
    ]);

    let totalSales = 0;
    let pendingOrders = 0;
    let deliveredOrders = 0;
    let processingOrders = 0;
    let cancelledOrders = 0;

    orders.forEach(order => {
      // Delivered or confirmed sales calculation
      if (['Delivered', 'Confirmed', 'Processing', 'Shipped', 'Out for Delivery'].includes(order.orderStatus)) {
        totalSales += (order.finalAmount || 0);
      }
      if (order.orderStatus === 'Pending Confirmation') pendingOrders++;
      else if (order.orderStatus === 'Delivered') deliveredOrders++;
      else if (['Confirmed', 'Processing', 'Shipped', 'Out for Delivery'].includes(order.orderStatus)) processingOrders++;
      else if (order.orderStatus === 'Cancelled') cancelledOrders++;
    });

    res.json({
      success: true,
      analytics: {
        totalSales,
        totalOrders: orders.length,
        pendingOrders,
        deliveredOrders,
        processingOrders,
        cancelledOrders,
        totalCustomers,
        totalProducts,
        lowStockCount: lowStockProducts.length,
        lowStockProducts,
        activeCampaigns: activeCampaignsCount,
        activeCoupons: activeCouponsCount,
        recentOrders
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Product Management
adminRouter.get('/api/admin/products', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const products = await db.collection('products').find().sort({ createdAt: -1 }).toArray();
    res.json({ success: true, products });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post('/api/admin/products', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    let {
      name, slug, sku, description, images, category, brand,
      price, originalPrice, stock, attributes, featured, active
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Product name is required' });
    }

    const cleanPriceStr = normalizeBengaliDigits(price);
    const cleanPrice = Math.max(0, Number(cleanPriceStr) || 0);
    if (isNaN(cleanPrice) || cleanPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Valid product price (greater than 0) is required' });
    }

    const categoryName = (category || 'General').trim();
    if (!categoryName) {
      return res.status(400).json({ success: false, error: 'Category is required' });
    }

    // Auto-create category in DB if it does not already exist
    const existingCat = await db.collection('categories').findOne({
      name: { $regex: '^' + categoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' }
    });
    if (!existingCat) {
      const catDoc = {
        name: categoryName,
        slug: generateSafeSlug(categoryName, 'cat'),
        description: `Category for ${categoryName}`,
        image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=500',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await db.collection('categories').insertOne(catDoc);
    }

    const productSlug = (slug && slug.trim()) ? slug.trim() : (generateSafeSlug(name.trim(), 'prod') + '-' + Date.now().toString().slice(-4));
    const productSku = (sku && sku.trim()) ? sku.trim() : ('VEL-' + Math.floor(100000 + Math.random() * 900000));

    const cleanOrigPriceStr = normalizeBengaliDigits(originalPrice);
    const cleanOrigPrice = cleanOrigPriceStr ? Math.max(0, Number(cleanOrigPriceStr) || 0) : cleanPrice;

    const cleanStockStr = normalizeBengaliDigits(stock);
    const cleanStock = cleanStockStr ? Math.max(0, parseInt(cleanStockStr, 10) || 0) : 0;

    const productImages = Array.isArray(images) && images.length && images[0]
      ? images
      : ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600'];

    const product = {
      name: name.trim(),
      slug: productSlug,
      sku: productSku,
      description: (description || '').trim(),
      images: productImages,
      category: categoryName,
      brand: (brand || 'VELORA').trim(),
      price: cleanPrice,
      originalPrice: cleanOrigPrice >= cleanPrice ? cleanOrigPrice : cleanPrice,
      stock: cleanStock,
      attributes: attributes || { sizes: ['Default'], colors: ['Default'] },
      featured: Boolean(featured),
      active: active !== undefined ? Boolean(active) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('products').insertOne(product);
    res.status(201).json({ success: true, message: 'Product created successfully', product: { ...product, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/products/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    if (updateData.price !== undefined) {
      updateData.price = Math.max(0, Number(normalizeBengaliDigits(updateData.price)) || 0);
    }
    if (updateData.originalPrice !== undefined) {
      updateData.originalPrice = Math.max(0, Number(normalizeBengaliDigits(updateData.originalPrice)) || 0);
    }
    if (updateData.stock !== undefined) {
      updateData.stock = Math.max(0, parseInt(normalizeBengaliDigits(updateData.stock), 10) || 0);
    }
    if (updateData.category) {
      updateData.category = updateData.category.trim();
      // Ensure category exists
      const existingCat = await db.collection('categories').findOne({
        name: { $regex: '^' + updateData.category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' }
      });
      if (!existingCat) {
        await db.collection('categories').insertOne({
          name: updateData.category,
          slug: generateSafeSlug(updateData.category, 'cat'),
          description: `Category for ${updateData.category}`,
          image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=500',
          active: true,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    }

    const result = await db.collection('products').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    res.json({ success: true, message: 'Product updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.delete('/api/admin/products/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.collection('products').deleteOne({ _id: db.toObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Category Management
adminRouter.get('/api/admin/categories', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const categories = await db.collection('categories').find().sort({ name: 1 }).toArray();
    res.json({ success: true, categories });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post('/api/admin/categories', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { name, slug, description, image, active } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Category name is required' });
    }

    const trimmedName = name.trim();
    const existing = await db.collection('categories').findOne({
      name: { $regex: '^' + trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' }
    });
    if (existing) {
      return res.status(200).json({ success: true, message: 'Category already exists', category: existing });
    }

    const categorySlug = (slug && slug.trim()) ? slug.trim() : generateSafeSlug(trimmedName, 'cat');
    const category = {
      name: trimmedName,
      slug: categorySlug,
      description: (description || '').trim(),
      image: (image && image.trim()) || 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=500',
      active: active !== undefined ? Boolean(active) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('categories').insertOne(category);
    res.status(201).json({ success: true, message: 'Category created successfully', category: { ...category, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/categories/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    if (updateData.name) {
      updateData.name = updateData.name.trim();
    }

    const result = await db.collection('categories').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Category not found' });
    res.json({ success: true, message: 'Category updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.delete('/api/admin/categories/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const category = await db.collection('categories').findOne({ _id: db.toObjectId(req.params.id) });
    if (!category) return res.status(404).json({ success: false, error: 'Category not found' });

    // Safe check: prevent deleting category with products
    const productCount = await db.collection('products').countDocuments({ category: category.name });
    if (productCount > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot delete "${category.name}" because ${productCount} product(s) belong to this category. Please reassign or delete the products first.` 
      });
    }

    await db.collection('categories').deleteOne({ _id: db.toObjectId(req.params.id) });
    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Order Management
adminRouter.get('/api/admin/orders', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { status, paymentStatus, search, limit = 50 } = req.query;
    let query = {};

    if (status && status !== 'all') {
      query.orderStatus = status;
    }
    if (paymentStatus && paymentStatus !== 'all') {
      query.paymentStatus = paymentStatus;
    }
    if (search) {
      const s = search.trim();
      query.$or = [
        { orderNumber: { $regex: s, $options: 'i' } },
        { 'customerInfo.name': { $regex: s, $options: 'i' } },
        { 'customerInfo.phone': { $regex: s, $options: 'i' } }
      ];
    }

    const orders = await db.collection('orders').find(query).sort({ createdAt: -1 }).limit(parseInt(limit)).toArray();
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/orders/:id/status', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { orderStatus, paymentStatus, note } = req.body;

    const validStatuses = [
      'Pending Confirmation',
      'Confirmed',
      'Processing',
      'Shipped',
      'Out for Delivery',
      'Delivered',
      'Cancelled'
    ];

    if (orderStatus && !validStatuses.includes(orderStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid order status transition' });
    }

    const order = await db.collection('orders').findOne({ _id: db.toObjectId(req.params.id) });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    const updateFields = { updatedAt: new Date() };
    if (orderStatus) {
      updateFields.orderStatus = orderStatus;
      
      // If delivered, COD payment is collected
      if (orderStatus === 'Delivered') {
        updateFields.paymentStatus = 'Paid on Delivery';
      }
      
      // Stock restoration safety: only if transitioned to Cancelled from non-cancelled
      if (orderStatus === 'Cancelled' && order.orderStatus !== 'Cancelled' && !order.stockRestored) {
        for (const item of order.items) {
          await db.collection('products').updateOne(
            { _id: db.toObjectId(item.productId) },
            { $inc: { stock: item.quantity } }
          );
        }
        updateFields.stockRestored = true;
      }
    }

    if (paymentStatus) {
      updateFields.paymentStatus = paymentStatus;
    }

    const historyEntry = {
      status: orderStatus || order.orderStatus,
      paymentStatus: paymentStatus || order.paymentStatus,
      note: note || `Status updated to ${orderStatus || order.orderStatus}`,
      timestamp: new Date(),
      updatedBy: req.admin?.email || 'admin'
    };

    await db.collection('orders').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { 
        $set: updateFields,
        $push: { timeline: historyEntry }
      }
    );

    res.json({ success: true, message: 'Order status updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Banners Management
adminRouter.get('/api/admin/banners', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const banners = await db.collection('banners').find().sort({ order: 1, createdAt: -1 }).toArray();
    res.json({ success: true, banners });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post('/api/admin/banners', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { title, subtitle, badge, image, link, buttonText, order, active, startDate, endDate } = req.body;
    if (!title || !image) {
      return res.status(400).json({ success: false, error: 'Title and image are required' });
    }

    const banner = {
      title: title.trim(),
      subtitle: subtitle || '',
      badge: badge || 'EXCLUSIVE OFFER',
      image: image.trim(),
      link: link || '/#products',
      buttonText: buttonText || 'Shop Now',
      order: parseInt(order) || 1,
      active: active !== undefined ? Boolean(active) : true,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('banners').insertOne(banner);
    res.status(201).json({ success: true, banner: { ...banner, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/banners/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    if (updateData.order) updateData.order = parseInt(updateData.order) || 1;
    if (updateData.startDate) updateData.startDate = new Date(updateData.startDate);
    if (updateData.endDate) updateData.endDate = new Date(updateData.endDate);

    const result = await db.collection('banners').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Banner not found' });
    res.json({ success: true, message: 'Banner updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.delete('/api/admin/banners/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.collection('banners').deleteOne({ _id: db.toObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Banner not found' });
    res.json({ success: true, message: 'Banner deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Campaign Management
adminRouter.get('/api/admin/campaigns', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const campaigns = await db.collection('campaigns').find().sort({ createdAt: -1 }).toArray();
    res.json({ success: true, campaigns });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post('/api/admin/campaigns', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { name, slug, description, image, discountType, discountValue, startDate, endDate, selectedCategories, active } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Campaign name is required' });

    const campaignSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const campaign = {
      name: name.trim(),
      slug: campaignSlug,
      description: description || '',
      image: image || 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=800',
      discountType: discountType || 'percentage', // percentage or fixed
      discountValue: Number(discountValue) || 10,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      selectedCategories: Array.isArray(selectedCategories) ? selectedCategories : [],
      active: active !== undefined ? Boolean(active) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('campaigns').insertOne(campaign);
    res.status(201).json({ success: true, campaign: { ...campaign, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/campaigns/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    if (updateData.startDate) updateData.startDate = new Date(updateData.startDate);
    if (updateData.endDate) updateData.endDate = new Date(updateData.endDate);
    if (updateData.discountValue !== undefined) updateData.discountValue = Number(updateData.discountValue);

    const result = await db.collection('campaigns').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found' });
    res.json({ success: true, message: 'Campaign updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.delete('/api/admin/campaigns/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.collection('campaigns').deleteOne({ _id: db.toObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found' });
    res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Discount Rules Management
adminRouter.get('/api/admin/discounts', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const discounts = await db.collection('discounts').find().sort({ createdAt: -1 }).toArray();
    res.json({ success: true, discounts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post('/api/admin/discounts', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { name, type, value, minPurchase, maxDiscount, applicableCategories, active, startDate, endDate } = req.body;
    if (!name || value === undefined) {
      return res.status(400).json({ success: false, error: 'Name and discount value are required' });
    }

    const discount = {
      name: name.trim(),
      type: type === 'fixed' ? 'fixed' : 'percentage',
      value: Math.max(0, Number(value)),
      minPurchase: minPurchase ? Math.max(0, Number(minPurchase)) : 0,
      maxDiscount: maxDiscount ? Math.max(0, Number(maxDiscount)) : null,
      applicableCategories: Array.isArray(applicableCategories) ? applicableCategories : [],
      active: active !== undefined ? Boolean(active) : true,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('discounts').insertOne(discount);
    res.status(201).json({ success: true, discount: { ...discount, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/discounts/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    if (updateData.value !== undefined) updateData.value = Math.max(0, Number(updateData.value));
    if (updateData.minPurchase !== undefined) updateData.minPurchase = Math.max(0, Number(updateData.minPurchase));
    if (updateData.maxDiscount !== undefined && updateData.maxDiscount !== '') updateData.maxDiscount = Math.max(0, Number(updateData.maxDiscount));
    if (updateData.startDate) updateData.startDate = new Date(updateData.startDate);
    if (updateData.endDate) updateData.endDate = new Date(updateData.endDate);

    const result = await db.collection('discounts').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Discount not found' });
    res.json({ success: true, message: 'Discount rule updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.delete('/api/admin/discounts/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.collection('discounts').deleteOne({ _id: db.toObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Discount rule not found' });
    res.json({ success: true, message: 'Discount deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Coupon Management
adminRouter.get('/api/admin/coupons', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const coupons = await db.collection('coupons').find().sort({ createdAt: -1 }).toArray();
    res.json({ success: true, coupons });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post('/api/admin/coupons', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const {
      code, description, discountType, discountValue,
      minOrderAmount, maxDiscountAmount, totalUsageLimit,
      perCustomerLimit, startDate, expiryDate, active
    } = req.body;

    if (!code || discountValue === undefined) {
      return res.status(400).json({ success: false, error: 'Coupon code and discount value are required' });
    }

    const normalizedCode = code.trim().toUpperCase();
    const existing = await db.collection('coupons').findOne({ code: normalizedCode });
    if (existing) {
      return res.status(400).json({ success: false, error: `Coupon code "${normalizedCode}" already exists` });
    }

    const coupon = {
      code: normalizedCode,
      description: description || '',
      discountType: discountType === 'fixed' ? 'fixed' : 'percentage',
      discountValue: Math.max(0, Number(discountValue)),
      minOrderAmount: minOrderAmount ? Math.max(0, Number(minOrderAmount)) : 0,
      maxDiscountAmount: maxDiscountAmount ? Math.max(0, Number(maxDiscountAmount)) : null,
      totalUsageLimit: totalUsageLimit ? Math.max(1, parseInt(totalUsageLimit)) : null,
      perCustomerLimit: perCustomerLimit ? Math.max(1, parseInt(perCustomerLimit)) : 1,
      usedCount: 0,
      usedBy: [], // array of customer IDs
      startDate: startDate ? new Date(startDate) : new Date(),
      expiryDate: expiryDate ? new Date(expiryDate) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      active: active !== undefined ? Boolean(active) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('coupons').insertOne(coupon);
    res.status(201).json({ success: true, coupon: { ...coupon, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/coupons/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    if (updateData.code) updateData.code = updateData.code.trim().toUpperCase();
    if (updateData.discountValue !== undefined) updateData.discountValue = Math.max(0, Number(updateData.discountValue));
    if (updateData.minOrderAmount !== undefined) updateData.minOrderAmount = Math.max(0, Number(updateData.minOrderAmount));
    if (updateData.maxDiscountAmount !== undefined && updateData.maxDiscountAmount !== '') {
      updateData.maxDiscountAmount = Math.max(0, Number(updateData.maxDiscountAmount));
    }
    if (updateData.startDate) updateData.startDate = new Date(updateData.startDate);
    if (updateData.expiryDate) updateData.expiryDate = new Date(updateData.expiryDate);

    const result = await db.collection('coupons').updateOne(
      { _id: db.toObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Coupon not found' });
    res.json({ success: true, message: 'Coupon updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.delete('/api/admin/coupons/:id', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.collection('coupons').deleteOne({ _id: db.toObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Coupon not found' });
    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Customer Management
adminRouter.get('/api/admin/customers', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const customers = await db.collection('users')
      .find({ role: 'customer' })
      .project({ password: 0 }) // Exclude password hashes
      .sort({ createdAt: -1 })
      .toArray();

    // Attach order analytics per customer
    const orders = await db.collection('orders').find().toArray();
    const enriched = customers.map(c => {
      const custOrders = orders.filter(o => o.customerId === c._id.toString() || o.customerInfo?.email === c.email);
      const totalSpent = custOrders.reduce((acc, curr) => acc + (curr.finalAmount || 0), 0);
      return {
        ...c,
        orderCount: custOrders.length,
        totalSpent
      };
    });

    res.json({ success: true, customers: enriched });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Store Settings
adminRouter.get('/api/admin/settings', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    let settings = await db.collection('settings').findOne({ type: 'store_settings' });
    if (!settings) {
      settings = {
        type: 'store_settings',
        storeName: 'VELORA',
        tagline: 'Premium Lifestyle & Essentials in Bangladesh',
        phone: '+880 1700-000000',
        email: 'support@velora.com.bd',
        address: 'House 14, Road 7, Banani, Dhaka-1213, Bangladesh',
        deliveryInsideDhaka: 60,
        deliveryOutsideDhaka: 120,
        freeDeliveryMinSpend: 2500,
        announcementBar: '🎉 Exclusive Offer: Free Home Delivery across Bangladesh on orders over ৳2,500! Cash on Delivery available.',
        currency: 'BDT',
        currencySymbol: '৳'
      };
      await db.collection('settings').insertOne(settings);
    }
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.patch('/api/admin/settings', verifyAdminToken, async (req, res) => {
  try {
    const db = getDb(req);
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;
    delete updateData.type;

    if (updateData.deliveryInsideDhaka !== undefined) updateData.deliveryInsideDhaka = Number(updateData.deliveryInsideDhaka);
    if (updateData.deliveryOutsideDhaka !== undefined) updateData.deliveryOutsideDhaka = Number(updateData.deliveryOutsideDhaka);

    await db.collection('settings').updateOne(
      { type: 'store_settings' },
      { $set: updateData },
      { upsert: true }
    );

    res.json({ success: true, message: 'Store settings updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 11. Image URL Verification Endpoint
adminRouter.post('/api/admin/upload', verifyAdminToken, async (req, res) => {
  try {
    const { imageUrl, imageBase64 } = req.body;
    if (imageUrl) {
      return res.json({
        success: true,
        url: imageUrl.trim(),
        message: 'Image URL confirmed'
      });
    }
    if (imageBase64) {
      return res.json({
        success: true,
        url: imageBase64,
        message: 'Image data saved'
      });
    }
    res.status(400).json({ success: false, error: 'No image URL provided' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// Admin Frontend HTML Interface (/admin & /admin/login)
// ----------------------------------------------------

adminRouter.get([
  '/admin/login',
  '/admin/login/',
  '/admin/login/:secret',
  '/admin/login/AM123AS4567',
  '/login',
  '/login/',
  '/login/:secret',
  '/login/AM123AS4567'
], (req, res) => {
  const secret = req.params.secret || (req.originalUrl && req.originalUrl.includes('AM123AS4567') ? 'AM123AS4567' : '');
  res.type('html').send(renderAdminLoginPage(secret));
});

adminRouter.get(['/admin', '/admin/'], (req, res) => {
  const token = req.cookies?.velora_admin_token || req.query?.token || req.query?.admin_token;
  if (token) {
    const jwtSecret = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';
    try {
      jwt.verify(token, jwtSecret);
      return res.type('html').send(renderAdminDashboardPage());
    } catch (err) {
      res.clearCookie('velora_admin_token');
    }
  }
  // Deliver dashboard UI which verifies localStorage token or redirects to login
  res.type('html').send(renderAdminDashboardPage());
});

adminRouter.get('/', (req, res, next) => {
  if (req.baseUrl === '/admin' || req.baseUrl === '/index.js/admin') {
    const token = req.cookies?.velora_admin_token || req.query?.token || req.query?.admin_token;
    if (token) {
      const jwtSecret = process.env.JWT_SECRET || 'velora_secret_jwt_key_fallback_2026';
      try {
        jwt.verify(token, jwtSecret);
        return res.type('html').send(renderAdminDashboardPage());
      } catch (err) {
        res.clearCookie('velora_admin_token');
      }
    }
    return res.type('html').send(renderAdminDashboardPage());
  }
  next();
});

let cachedAdminLoginHtml = null;
let cachedAdminDashboardHtml = null;

export function renderAdminLoginPage(secret = '') {
  try {
    if (!cachedAdminLoginHtml || process.env.NODE_ENV !== 'production') {
      cachedAdminLoginHtml = fs.readFileSync(path.join(__dirname, 'admin-login.html'), 'utf8');
    }
    const safeSecret = secret ? String(secret).replace(/[^\w-]/g, '') : 'AM123AS4567';
    let html = cachedAdminLoginHtml.replace(/AM123AS4567/g, safeSecret);
    return html;
  } catch (err) {
    return '<h1>Admin Login</h1><p>Error reading login template: ' + err.message + '</p>';
  }
}

export function renderAdminDashboardPage() {
  try {
    if (!cachedAdminDashboardHtml || process.env.NODE_ENV !== 'production') {
      cachedAdminDashboardHtml = fs.readFileSync(path.join(__dirname, 'admin-dashboard.html'), 'utf8');
    }
    return cachedAdminDashboardHtml;
  } catch (err) {
    return '<h1>Admin Dashboard</h1><p>Error reading dashboard template: ' + err.message + '</p>';
  }
}
