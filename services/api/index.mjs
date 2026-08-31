// AI Maze — sample JSON API origin (a genuinely NON-S3 origin).
//
// Exposed via a Lambda Function URL behind CloudFront (the `/api/*` behavior).
// It exists to prove two things about the maze:
//   1. The REAL origin can be anything — here an application/json endpoint on a
//      Lambda, not an S3 bucket. The maze corpus is still served only from
//      private S3; this origin is only ever hit by legitimate (non-decoyed)
//      traffic, exactly like the HTML site and SPA origins.
//   2. It is the data source the SPA hydrates from, so the maze renderer
//      captures this JSON when it renders /app and the generator can produce a
//      schema-isomorphic JSON decoy.
//
// arm64 / Node.js 22. No dependencies.

// Each product carries its BATCH CARD fields — garden, elevation, flush, rest
// days, and the initials of whoever mixed it — because that is how the shop
// presents a blend and how the shed actually records one. It also carries an
// `image` URL, which a catalogue API realistically would, and which gives a JSON
// decoy an existing URL-valued field to point at its beacon (replacing a value
// keeps the schema isomorphic; adding a key would not). The SPA renders these
// rows directly, so the schema and the UI stay in step, and a schema-isomorphic
// JSON decoy inherits the same shape.
const CATALOGUE = {
  currency: 'USD',
  updated: '2026-08-04',
  categories: [
    { slug: 'black', name: 'Black' },
    { slug: 'green', name: 'Green' },
    { slug: 'oolong', name: 'Oolong' },
    { slug: 'herbal', name: 'Herbal' },
  ],
  products: [
    { sku: 'HRB-FOG-100', image: '/img/harbor-fog.svg', batch: 4417, name: 'Harbor Fog', category: 'black', price: 18.5, grams: 100, garden: 'Dikom, Assam', elevation: 980, flush: 'Second', restedDays: 14, mixedBy: 'R.A.', inStock: true, notes: 'Second-flush Assam cut with dried sea buckthorn from the dunes north of the harbour.' },
    { sku: 'TDL-GRN-080', image: '/img/tideline-green.svg', batch: 4402, name: 'Tideline Green', category: 'green', price: 16.0, grams: 80, garden: 'Kanoya, Shizuoka', elevation: 210, flush: 'First', restedDays: 14, mixedBy: 'J.M.', inStock: true, notes: 'Steamed sencha layered over toasted brown rice, four parts to one.' },
    { sku: 'CLD-KLN-060', image: '/img/cold-kiln-oolong.svg', batch: 4388, name: 'Cold Kiln Oolong', category: 'oolong', price: 24.0, grams: 60, garden: 'Dong Ding terrace', elevation: 1200, flush: 'Winter', restedDays: 42, mixedBy: 'R.A.', inStock: false, notes: 'Twice-roasted and rested six weeks. Stone fruit and a dry mineral finish.' },
    { sku: 'NTH-CST-090', image: '/img/northern-coast.svg', batch: 4421, name: 'Northern Coast', category: 'herbal', price: 14.0, grams: 90, garden: 'Dune plot, Pier Road', elevation: 4, flush: 'Summer', restedDays: 10, mixedBy: 'S.K.', inStock: true, notes: 'Rosehip, sea buckthorn, and a little dune mint from behind the shed.' },
    { sku: 'SLT-MRSH-075', image: '/img/salt-marsh.svg', batch: 4409, name: 'Salt Marsh', category: 'green', price: 17.25, grams: 75, garden: 'Anxi, Fujian', elevation: 760, flush: 'Second', restedDays: 14, mixedBy: 'J.M.', inStock: true, notes: 'Pan-fired green with a saline minerality that suits hard water.' },
    { sku: 'HGH-NUW-100', image: '/img/high-nuwara.svg', batch: 4395, name: 'High Nuwara', category: 'black', price: 19.75, grams: 100, garden: 'Nuwara, Central', elevation: 1890, flush: 'Second', restedDays: 21, mixedBy: 'S.K.', inStock: true, notes: 'Brisk high-grown Ceylon, rested three weeks to round off the edge.' },
  ],
};

/** @param {import('aws-lambda').LambdaFunctionURLEvent} event */
export const handler = async (event) => {
  const path = event?.rawPath || '/';

  // /api/products -> full catalogue. Anything else under /api -> 404 JSON.
  if (path.replace(/\/+$/, '').endsWith('/products') || path.replace(/\/+$/, '').endsWith('/api')) {
    return json(200, CATALOGUE);
  }
  return json(404, { error: 'not_found', path });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Real API responses are cacheable; the maze never routes decoyed bots
      // here — they are served the corpus IN PLACE at this same URL, so this origin
      // only ever sees legitimate traffic.
      'cache-control': 'public, max-age=60',
    },
    body: JSON.stringify(obj),
  };
}
