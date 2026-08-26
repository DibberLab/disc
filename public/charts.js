/* charts.js — small dependency-free SVG chart helpers.
   Every chart draws into a viewBox of 720x300 and scales to its container. */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var W = 720, H = 300;
  var PAD = { l: 46, r: 14, t: 14, b: 38 };

  function el(name, attrs, text) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function svgRoot(height) {
    var h = height || H;
    var s = el('svg', {
      viewBox: '0 0 ' + W + ' ' + h,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img'
    });
    return s;
  }

  function niceTicks(max, count) {
    var step = max / count, out = [];
    for (var i = 0; i <= count; i++) out.push(+(step * i).toFixed(4));
    return out;
  }

  function plotBox(h) {
    return { x0: PAD.l, x1: W - PAD.r, y0: PAD.t, y1: h - PAD.b };
  }

  /* ---------------------------------------------------------------- axes */
  function drawFrame(svg, cfg, h) {
    var b = plotBox(h);
    var ticks = niceTicks(cfg.yMax, cfg.yTicks || 4);
    ticks.forEach(function (t) {
      var y = b.y1 - (t / cfg.yMax) * (b.y1 - b.y0);
      svg.appendChild(el('line', { x1: b.x0, x2: b.x1, y1: y, y2: y, class: 'gridline' }));
      svg.appendChild(el('text', {
        x: b.x0 - 8, y: y + 4, 'text-anchor': 'end', class: 'axistext'
      }, cfg.fmtY ? cfg.fmtY(t) : String(t)));
    });
    return b;
  }

  function drawXLabels(svg, labels, b, h) {
    if (!labels.length) return;
    var maxLabels = 7;
    var step = Math.max(1, Math.ceil(labels.length / maxLabels));
    var span = b.x1 - b.x0;
    labels.forEach(function (lab, i) {
      if (i % step !== 0 && i !== labels.length - 1) return;
      var x = labels.length === 1 ? (b.x0 + span / 2) : b.x0 + (i / (labels.length - 1)) * span;
      svg.appendChild(el('text', {
        x: x, y: h - PAD.b + 18, 'text-anchor': 'middle', class: 'axistext'
      }, lab));
    });
  }

  /* ---------------------------------------------------------- line chart */
  function line(mount, cfg) {
    mount.innerHTML = '';
    var h = cfg.height || H;
    var svg = svgRoot(h);
    var b = drawFrame(svg, cfg, h);
    var n = cfg.labels.length;
    var span = b.x1 - b.x0;

    function xAt(i) { return n === 1 ? b.x0 + span / 2 : b.x0 + (i / (n - 1)) * span; }
    function yAt(v) { return b.y1 - (v / cfg.yMax) * (b.y1 - b.y0); }

    cfg.series.forEach(function (s) {
      var d = '', open = false;
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined || isNaN(v)) { open = false; return; }
        d += (open ? ' L' : ' M') + xAt(i) + ' ' + yAt(v);
        open = true;
      });
      if (d) {
        svg.appendChild(el('path', {
          d: d.trim(), fill: 'none', stroke: s.color, 'stroke-width': s.width || 2.5,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          'stroke-dasharray': s.dashed ? '6 5' : null
        }));
      }
      if (s.dots !== false) {
        s.values.forEach(function (v, i) {
          if (v === null || v === undefined || isNaN(v)) return;
          var c = el('circle', { cx: xAt(i), cy: yAt(v), r: n > 40 ? 2 : 3.5, fill: s.color });
          c.appendChild(el('title', {}, cfg.labels[i] + ' · ' + s.name + ' · ' +
            (cfg.fmtV ? cfg.fmtV(v) : v)));
          svg.appendChild(c);
        });
      }
    });

    drawXLabels(svg, cfg.labels, b, h);
    mount.appendChild(svg);
  }

  /* ----------------------------------------------------------- bar chart */
  function bars(mount, cfg) {
    mount.innerHTML = '';
    var h = cfg.height || H;
    var svg = svgRoot(h);
    var b = drawFrame(svg, cfg, h);
    var groups = cfg.categories.length;
    var series = cfg.series.length;
    var slot = (b.x1 - b.x0) / groups;
    var gap = Math.min(14, slot * 0.18);
    var bw = (slot - gap) / series;

    cfg.categories.forEach(function (cat, gi) {
      cfg.series.forEach(function (s, si) {
        var v = s.values[gi];
        if (v === null || v === undefined || isNaN(v)) return;
        var x = b.x0 + gi * slot + gap / 2 + si * bw;
        var y = b.y1 - (v / cfg.yMax) * (b.y1 - b.y0);
        var r = el('rect', {
          x: x + 1, y: y, width: Math.max(1, bw - 2), height: Math.max(0, b.y1 - y),
          fill: s.color, rx: 2
        });
        r.appendChild(el('title', {}, cat + ' · ' + s.name + ' · ' +
          (cfg.fmtV ? cfg.fmtV(v) : v)));
        svg.appendChild(r);
        if (cfg.valueLabels) {
          svg.appendChild(el('text', {
            x: x + bw / 2, y: y - 6, 'text-anchor': 'middle', class: 'axistext'
          }, cfg.fmtV ? cfg.fmtV(v) : String(v)));
        }
      });
      svg.appendChild(el('text', {
        x: b.x0 + gi * slot + slot / 2, y: h - PAD.b + 18,
        'text-anchor': 'middle', class: 'axistext'
      }, cat));
    });

    mount.appendChild(svg);
  }

  /* ------------------------------------------------------- legend helper */
  function legend(series) {
    return '<p class="legend">' + series.map(function (s) {
      return '<span><i class="swatch" style="background:' + s.color + '"></i>' + s.name + '</span>';
    }).join('') + '</p>';
  }

  global.Charts = { line: line, bars: bars, legend: legend };
})(window);
