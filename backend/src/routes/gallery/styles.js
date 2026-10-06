const express = require('express');
const { db } = require('../../database/db');
const router = express.Router();
const logger = require('../../utils/logger');
const { effectiveCssTemplateId } = require('../../services/galleryTheme');

router.get('/:slug/css-template', async (req, res) => {
  try {
    const { slug } = req.params;

    // Find the event by slug
    const event = await db('events')
      .where({ slug })
      .select('css_template_id', 'color_theme', 'custom_theme_enabled')
      .first();

    // The gallery's own template when it uses custom styling, else the
    // global one from the Branding theme (services/galleryTheme).
    const templateId = event ? await effectiveCssTemplateId(event) : null;
    if (!templateId) {
      // No custom CSS - return 204 No Content
      return res.status(204).send();
    }

    // Get the template if it's enabled
    const template = await db('css_templates')
      .where({ id: templateId, is_enabled: true })
      .select('css_content')
      .first();

    if (!template || !template.css_content) {
      return res.status(204).send();
    }

    // Return CSS with caching headers
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    res.send(template.css_content);
  } catch (error) {
    logger.error('Get CSS template error:', error);
    res.status(500).send('/* Error loading template */');
  }
});

module.exports = router;
