// Meridian Coastal Tea — client-side hydration.
//
// Fetches the catalogue from the JSON API and renders a grid of BATCH CARDS into
// #app. This is the JS the maze renderer must execute: without it the page is
// an empty shell; with it the DOM carries the real content structure a decoy must
// mimic — a <ul.product-grid> of <li.product-card>, each holding a head, an h3,
// and a run of .row leaves whose labels come from CSS rather than the markup.
(async function () {
  var app = document.getElementById('app');
  var nav = document.querySelector('.site-nav');

  // All catalogue fields are inserted via textContent so the API response is
  // always treated as text, never as markup.
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function row(cls, value) {
    var div = el('div', 'row ' + cls);
    div.appendChild(el('span', 'v', value));
    return div;
  }

  try {
    var res = await fetch('/api/products', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();

    (data.categories || []).forEach(function (c) {
      var a = document.createElement('a');
      a.href = '#' + c.slug;
      a.textContent = c.name;
      nav.appendChild(a);
    });

    var ul = document.createElement('ul');
    ul.className = 'product-grid';
    (data.products || []).forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'product-card';
      li.setAttribute('data-sku', p.sku);
      li.setAttribute('data-stock', p.inStock ? 'in' : 'out');
      var head = el('div', 'batch-head');
      head.appendChild(el('span', null, p.category));
      head.appendChild(el('span', null, 'No. ' + p.batch));
      li.appendChild(head);
      if (p.image) {
        var img = el('img', 'tin');
        img.src = p.image;
        img.alt = '';
        img.loading = 'lazy';
        li.appendChild(img);
      }
      li.appendChild(el('h3', null, p.name));
      li.appendChild(row('garden', p.garden));
      li.appendChild(row('elev', p.elevation + ' m'));
      li.appendChild(row('flush', p.flush));
      li.appendChild(row('rested', p.restedDays + ' days'));
      li.appendChild(row('price', '$' + Number(p.price).toFixed(2) + ' / ' + p.grams + 'g'));
      li.appendChild(el('p', 'notes', p.notes));
      ul.appendChild(li);
    });

    app.replaceChildren(ul);
    app.setAttribute('data-state', 'ready');
    app.setAttribute('data-count', String((data.products || []).length));
  } catch (err) {
    app.setAttribute('data-state', 'error');
    // An empty screen is an invitation to act, not a place to apologise.
    app.replaceChildren(el('p', 'loading', 'The catalogue did not load. Reload, or call the shed on Pier Road.'));
  }
})();
