import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// CORS is handled by Shopify App Proxy automatically
// but let's allow preview domain just in case
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// GET route (for testing in browser)
app.get('/submit-attr-ratings', (req, res) => {
  res.json({ ok: true, message: "Ratings endpoint is alive. POST only." });
});

// POST route (Shopify proxy forwards here)
app.post('/submit-attr-ratings', async (req, res) => {
  try {
    const body = req.body || {};
    console.log("Incoming rating data:", body);

    if (!body.product_id) {
      return res.status(400).json({ message: "Missing product_id" });
    }

    // Shopify product GID format
    const productGid = `gid://shopify/Product/${body.product_id}`;

    // Fetch current ratings metafield
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

    const resp1 = await fetch(`https://${process.env.SHOP}/admin/api/2024-04/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables: { id: productGid } })
    });

    const json1 = await resp1.json();
    let current = {};

    if (json1?.data?.product?.metafield?.value) {
      try {
        current = JSON.parse(json1.data.product.metafield.value);
      } catch (e) {}
    }

    // Merge new ratings
    const updated = { ...current };

    for (const key of [
      "value_for_money",
      "tracking",
      "dust_level",
      "durability",
      "clumping",
      "odour_control"
    ]) {
      if (body[key]) {
        const val = Number(body[key]);
        if (!updated[key]) updated[key] = { avg: 0, count: 0 };

        const oldAvg = updated[key].avg || 0;
        const oldCount = updated[key].count || 0;

        updated[key].count = oldCount + 1;
        updated[key].avg = ((oldAvg * oldCount) + val) / updated[key].count;
      }
    }

    // Save metafield
    const mutation = `
      mutation SaveRatings($ownerId: ID!, $value: String!) {
        metafieldsSet(metafields: [{
          ownerId: $ownerId,
          namespace: "custom",
          key: "custom_ratings",
          type: "json",
          value: $value
        }]) {
          userErrors { field message }
        }
      }
    `;

    const resp2 = await fetch(`https://${process.env.SHOP}/admin/api/2024-04/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          ownerId: productGid,
          value: JSON.stringify(updated)
        }
      })
    });

    const json2 = await resp2.json();
    console.log("Save response:", json2);

    if (json2?.data?.metafieldsSet?.userErrors?.length) {
      return res.status(400).json({ message: "Shopify error", errors: json2.data.metafieldsSet.userErrors });
    }

    return res.json({ message: "Thanks for rating!" });

  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Petso ratings API listening on", PORT);
});
