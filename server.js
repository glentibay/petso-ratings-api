import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// CORS is handled by Shopify App Proxy automatically
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Simple GET route (for testing in browser)
app.get('/submit-attr-ratings', (req, res) => {
  res.json({ ok: true, message: 'Ratings endpoint is alive. POST only.' });
});

// POST route (Shopify proxy forwards here)
app.post('/submit-attr-ratings', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('Incoming rating data:', body);

    if (!body.product_id) {
      return res.status(400).json({ message: 'Missing product_id' });
    }

    // Shopify product GID format
    const productGid = `gid://shopify/Product/${body.product_id}`;

    // 1) Read existing metafield
    const query = `
      query GetRatings($id: ID!) {
        product(id: $id) {
          metafield(namespace: "custom", key: "custom_ratings") {
            id
            type
            value
          }
        }
      }
    `;

    const resp1 = await fetch(
      `https://${process.env.SHOP}/admin/api/2024-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { id: productGid } }),
      }
    );

    const json1 = await resp1.json();
    console.log('Existing ratings metafield:', JSON.stringify(json1, null, 2));

    let current = {};
    if (json1?.data?.product?.metafield?.value) {
      try {
        current = JSON.parse(json1.data.product.metafield.value);
      } catch (e) {
        console.warn('Failed to parse existing ratings JSON:', e);
      }
    }

    // 2) Merge new ratings into existing
    const updated = { ...current };

    // Ensure total_reviews exists and increment
    if (typeof updated.total_reviews !== 'number') {
      updated.total_reviews = 0;
    }
    updated.total_reviews += 1;

    const keys = [
      'value_for_money',
      'tracking',
      'dust_level',
      'durability',
      'clumping',
      'odour_control',
    ];

    keys.forEach((key) => {
      if (body[key]) {
        const val = Number(body[key]);
        if (!updated[key]) {
          updated[key] = { avg: 0, count: 0 };
        }
        const oldAvg = updated[key].avg || 0;
        const oldCount = updated[key].count || 0;
        updated[key].count = oldCount + 1;
        updated[key].avg =
          (oldAvg * oldCount + val) / updated[key].count;
      }
    });

    // 3) Save metafield back to Shopify
    const mutation = `
      mutation SaveRatings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            type
            value
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId: productGid,
          namespace: 'custom',
          key: 'custom_ratings',
          value: JSON.stringify(updated),
        },
      ],
    };

    const resp2 = await fetch(
      `https://${process.env.SHOP}/admin/api/2024-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: mutation, variables }),
      }
    );

    const json2 = await resp2.json();
    console.log('Save response:', JSON.stringify(json2, null, 2));

    const metafieldsSet = json2?.data?.metafieldsSet;

    if (!metafieldsSet) {
      return res
        .status(500)
        .json({ message: 'No metafieldsSet result from Shopify', raw: json2 });
    }

    if (metafieldsSet.userErrors && metafieldsSet.userErrors.length) {
      return res.status(400).json({
        message: 'Shopify error',
        errors: metafieldsSet.userErrors,
      });
    }

    return res.json({
      message: 'Thanks for rating!',
      saved: metafieldsSet.metafields,
    });
  } catch (err) {
    console.error('Server error while handling ratings:', err);
    return res
      .status(500)
      .json({ message: 'Server error', error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Petso ratings API listening on', PORT);
});