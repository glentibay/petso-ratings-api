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
    console.log('Incoming rating/review data:', body);

    // -----------------------------------------
    // 0) Warmup ping from frontend / GitHub
    // -----------------------------------------
    if (body.warmup) {
      return res.json({ ok: true, warmed: true });
    }

    // -----------------------------------------
    // 1) Written review branch (custom.custom_reviews)
    //    Triggered if body.review exists
    // -----------------------------------------
    if (body.review) {
      if (!body.product_id) {
        return res
          .status(400)
          .json({ ok: false, message: 'Missing product_id' });
      }

      const productGid = `gid://shopify/Product/${body.product_id}`;

      // 1a) Fetch existing reviews metafield
      const reviewsQuery = `
        query GetReviews($id: ID!) {
          product(id: $id) {
            metafield(namespace: "custom", key: "custom_reviews") {
              id
              type
              value
            }
          }
        }
      `;

      const reviewsResp1 = await fetch(
        `https://${process.env.SHOP}/admin/api/2024-04/graphql.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: reviewsQuery,
            variables: { id: productGid },
          }),
        }
      );

      const reviewsJson1 = await reviewsResp1.json();
      console.log(
        'Existing reviews metafield:',
        JSON.stringify(reviewsJson1, null, 2)
      );

      let currentReviews = [];
      if (reviewsJson1?.data?.product?.metafield?.value) {
        try {
          currentReviews = JSON.parse(
            reviewsJson1.data.product.metafield.value
          );
          if (!Array.isArray(currentReviews)) currentReviews = [];
        } catch (e) {
          console.warn('Failed to parse existing reviews JSON:', e);
          currentReviews = [];
        }
      }

      // 1b) Build new review object
      const newReview = {
        name: body.name || 'Anonymous',
        review: body.review,
        rating: body.rating ? Number(body.rating) : null,
        date: new Date().toISOString(),
      };

      // 1c) Append to array
      currentReviews.push(newReview);

      // 1d) Save back to custom.custom_reviews
      const reviewsMutation = `
        mutation SaveReviews($metafields: [MetafieldsSetInput!]!) {
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

      const reviewsVariables = {
        metafields: [
          {
            ownerId: productGid,
            namespace: 'custom',
            key: 'custom_reviews',
            type: 'json',
            value: JSON.stringify(currentReviews),
          },
        ],
      };

      const reviewsResp2 = await fetch(
        `https://${process.env.SHOP}/admin/api/2024-04/graphql.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: reviewsMutation,
            variables: reviewsVariables,
          }),
        }
      );

      const reviewsJson2 = await reviewsResp2.json();
      console.log(
        'Save response (reviews):',
        JSON.stringify(reviewsJson2, null, 2)
      );

      const reviewsSet = reviewsJson2?.data?.metafieldsSet;
      if (!reviewsSet) {
        return res.status(500).json({
          ok: false,
          message: 'No metafieldsSet result from Shopify',
          raw: reviewsJson2,
        });
      }

      if (reviewsSet.userErrors && reviewsSet.userErrors.length) {
        return res.status(400).json({
          ok: false,
          message: 'Shopify error',
          errors: reviewsSet.userErrors,
        });
      }

      return res.json({
        ok: true,
        message: 'Review submitted!',
        review: newReview,
      });
    }

    // -----------------------------------------
    // 2) Attribute ratings branch (custom.custom_ratings)
    //    This is your original logic
    // -----------------------------------------
    if (!body.product_id) {
      return res.status(400).json({ message: 'Missing product_id' });
    }

    const productGid = `gid://shopify/Product/${body.product_id}`;

    // 2a) Read existing ratings metafield
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
    console.log(
      'Existing ratings metafield:',
      JSON.stringify(json1, null, 2)
    );

    let current = {};
    if (json1?.data?.product?.metafield?.value) {
      try {
        current = JSON.parse(json1.data.product.metafield.value);
      } catch (e) {
        console.warn('Failed to parse existing ratings JSON:', e);
      }
    }

    // 2b) Merge new ratings into existing
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

    // 2c) Save ratings metafield
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
    console.log('Save response (ratings):', JSON.stringify(json2, null, 2));

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
    console.error(
      'Server error while handling ratings/reviews:',
      err
    );
    return res
      .status(500)
      .json({ message: 'Server error', error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Petso ratings API listening on', PORT);
});