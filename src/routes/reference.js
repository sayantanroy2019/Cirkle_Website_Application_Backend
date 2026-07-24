import { Router } from 'express';
import { pool } from '../config/db.js';

const referenceRouter = Router();

referenceRouter.get('/cities', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM cities ');
    res.json({ cities: result.rows });
  } catch (error) {
    console.error('Error fetching cities:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

referenceRouter.get('/lifestyle-tags', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, label, category FROM lifestyle_tags');
    res.json({ lifestyleTags: result.rows });
  } catch (error) {
    console.error('Error fetching lifestyle tags:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

referenceRouter.get('/event-categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, label FROM event_categories ORDER BY label ASC');
    res.json({ eventCategories: result.rows });
  } catch (error) {
    console.error('Error fetching event categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default referenceRouter;
