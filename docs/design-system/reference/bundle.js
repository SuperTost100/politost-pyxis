/* @ds-bundle: {"format":4,"namespace":"Pyxis","components":[{"name":"Logo"},{"name":"Icon"},{"name":"Button"},{"name":"IconButton"},{"name":"SegmentedTabs"},{"name":"TextField"},{"name":"Chip"},{"name":"Tag"},{"name":"CitationChip"},{"name":"MasteryBar"},{"name":"PlanCard"},{"name":"StatTile"},{"name":"LessonTile"},{"name":"PathNode"},{"name":"GapItem"},{"name":"Composer"},{"name":"ChatMessage"},{"name":"QuizOption"},{"name":"Flashcard"},{"name":"EngineRow"}]} */
(function () {
  var React = window.React, h = React.createElement, useState = React.useState;
  var ICONS = {"message-circle":"<path d=\"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719\" />","graduation-cap":"<path d=\"M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z\" /> <path d=\"M22 10v6\" /> <path d=\"M6 12.5V16a6 3 0 0 0 12 0v-3.5\" />","book-open":"<path d=\"M12 5v16\" /> <path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\" />","layers":"<path d=\"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z\" /> <path d=\"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12\" /> <path d=\"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17\" />","target":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <circle cx=\"12\" cy=\"12\" r=\"6\" /> <circle cx=\"12\" cy=\"12\" r=\"2\" />","network":"<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\" /> <rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\" /> <rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\" /> <path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\" /> <path d=\"M12 12V8\" />","pencil-line":"<path d=\"M13 21h8\" /> <path d=\"m15 5 4 4\" /> <path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\" />","list-checks":"<path d=\"M13 5h8\" /> <path d=\"M13 12h8\" /> <path d=\"M13 19h8\" /> <path d=\"m3 17 2 2 4-4\" /> <path d=\"m3 7 2 2 4-4\" />","square-split-horizontal":"<path d=\"M12 2v20\" /> <path d=\"M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3\" /> <path d=\"M8 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3\" />","repeat":"<path d=\"m17 2 4 4-4 4\" /> <path d=\"M3 11v-1a4 4 0 0 1 4-4h14\" /> <path d=\"m7 22-4-4 4-4\" /> <path d=\"M21 13v1a4 4 0 0 1-4 4H3\" />","file-pen":"<path d=\"M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34\" /> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /> <path d=\"M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z\" />","lock":"<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\" />","paperclip":"<path d=\"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551\" />","image":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\" /> <circle cx=\"9\" cy=\"9\" r=\"2\" /> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\" />","signature":"<path d=\"m21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284\" /> <path d=\"M3 21h18\" />","send":"<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\" /> <path d=\"m21.854 2.147-10.94 10.939\" />","square":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" />","copy":"<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />","thumbs-up":"<path d=\"M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z\" /> <path d=\"M7 10v12\" />","thumbs-down":"<path d=\"M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z\" /> <path d=\"M17 14V2\" />","quote":"<path d=\"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\" /> <path d=\"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\" />","book-marked":"<path d=\"M10 2v7.751a.25.25 0 00.407.195l2.28-1.834a.5.5 0 01.627 0l2.28 1.834A.25.25 0 0016 9.751V2\" /> <path d=\"M4 19.5v-15A2.5 2.5 0 016.5 2H19a1 1 0 011 1v18a1 1 0 01-1 1H6.5a1 1 0 010-5H20\" />","settings":"<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />","search":"<path d=\"m21 21-4.34-4.34\" /> <circle cx=\"11\" cy=\"11\" r=\"8\" />","plus":"<path d=\"M5 12h14\" /> <path d=\"M12 5v14\" />","arrow-left":"<path d=\"m12 19-7-7 7-7\" /> <path d=\"M19 12H5\" />","x":"<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />","chevron-right":"<path d=\"m9 18 6-6-6-6\" />","sigma":"<path d=\"M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2\" />","code":"<path d=\"m16 18 6-6-6-6\" /> <path d=\"m8 6-6 6 6 6\" />","chart-line":"<path d=\"M3 3v16a2 2 0 0 0 2 2h16\" /> <path d=\"m19 9-5 5-4-4-3 3\" />","circle-alert":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\" /> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\" />","check":"<path d=\"M20 6 9 17l-5-5\" />","hard-drive":"<path d=\"M10 16h.01\" /> <path d=\"M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" /> <path d=\"M21.946 12.013H2.054\" /> <path d=\"M6 16h.01\" />","cloud":"<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\" />","key-round":"<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\" /> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />","terminal":"<path d=\"M12 19h8\" /> <path d=\"m4 17 6-6-6-6\" />","refresh-cw":"<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />","compass":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z\" />","cpu":"<path d=\"M12 20v2\" /> <path d=\"M12 2v2\" /> <path d=\"M17 20v2\" /> <path d=\"M17 2v2\" /> <path d=\"M2 12h2\" /> <path d=\"M2 17h2\" /> <path d=\"M2 7h2\" /> <path d=\"M20 12h2\" /> <path d=\"M20 17h2\" /> <path d=\"M20 7h2\" /> <path d=\"M7 20v2\" /> <path d=\"M7 2v2\" /> <rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\" /> <rect x=\"8\" y=\"8\" width=\"8\" height=\"8\" rx=\"1\" />","flag":"<path d=\"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528\" />","clock":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 6v6l4 2\" />","circle-check":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m16 9-5.5 5.5L8 12\" />","circle-x":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m15 9-6 6\" /> <path d=\"m9 9 6 6\" />","upload":"<path d=\"M12 3v12\" /> <path d=\"m17 8-5-5-5 5\" /> <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" />"};
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }

  function Icon(p) {
    var size = p.size || 20;
    return h('svg', { className: cx('px-icon', p.className), width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: p.strokeWidth || 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': p.label ? undefined : true, role: p.label ? 'img' : undefined, 'aria-label': p.label, dangerouslySetInnerHTML: { __html: ICONS[p.name] || '' } });
  }


  // Pyxis mark: star trails around the pole star. Colours come from tokens (ink, star).
  var TRAILS = [[16, 200, 230, .9], [28, 150, 200, .7], [40, 230, 170, .5]];
  function arc(r, st, sp) { var a0 = st * Math.PI / 180, a1 = (st + sp) * Math.PI / 180; return 'M' + (50 + r * Math.cos(a0)).toFixed(2) + ',' + (54 + r * Math.sin(a0)).toFixed(2) + ' A' + r + ',' + r + ' 0 ' + (sp > 180 ? 1 : 0) + ' 1 ' + (50 + r * Math.cos(a1)).toFixed(2) + ',' + (54 + r * Math.sin(a1)).toFixed(2); }
  function Logo(p) {
    var size = p.size || 32, k = 9 * .18;
    var mark = h('svg', { width: size, height: size, viewBox: '6 10 88 88', role: 'img', 'aria-label': p.wordmark ? undefined : 'Pyxis', 'aria-hidden': p.wordmark ? true : undefined, style: { flex: 'none' } },
      TRAILS.map(function (t, i) { return h('path', { key: i, d: arc(t[0], t[1], t[2]), fill: 'none', stroke: p.inverse ? 'var(--on-primary)' : 'var(--ink)', strokeWidth: 5, strokeLinecap: 'round', opacity: t[3] }); }),
      h('path', { d: 'M50,45 C' + (50 + k) + ',' + (54 - k) + ' ' + (50 + k) + ',' + (54 - k) + ' 59,54 C' + (50 + k) + ',' + (54 + k) + ' ' + (50 + k) + ',' + (54 + k) + ' 50,63 C' + (50 - k) + ',' + (54 + k) + ' ' + (50 - k) + ',' + (54 + k) + ' 41,54 C' + (50 - k) + ',' + (54 - k) + ' ' + (50 - k) + ',' + (54 - k) + ' 50,45Z', fill: 'var(--star)' }));
    if (!p.wordmark) return mark;
    return h('span', { className: 'px-logo', style: { fontSize: size * .8 } }, mark, h('span', null, 'Pyxis'));
  }

  function Button(p) {
    var variant = p.variant || 'primary', size = p.size || 'md';
    var rest = Object.assign({}, p); ['variant', 'size', 'icon', 'block', 'className', 'children'].forEach(function (k) { delete rest[k]; });
    return h('button', Object.assign({ type: 'button' }, rest, { className: cx('px-btn', 'px-btn-' + variant, size !== 'md' && 'px-btn-' + size, p.block && 'px-btn-block', p.className) }),
      p.icon && h(Icon, { name: p.icon, size: size === 'sm' ? 16 : 18 }), p.children);
  }

  function IconButton(p) {
    return h('button', { type: 'button', className: cx('px-btn', 'px-btn-' + (p.variant || 'secondary'), 'px-iconbtn', p.size === 'sm' && 'px-btn-sm'), 'aria-label': p.label, title: p.label, onClick: p.onClick, disabled: p.disabled },
      h(Icon, { name: p.icon, size: p.size === 'sm' ? 16 : 18 }));
  }

  function SegmentedTabs(p) {
    var st = useState(p.value != null ? p.value : (p.items[0] && p.items[0].value));
    var value = p.value != null ? p.value : st[0];
    return h('div', { className: 'px-seg', role: 'tablist', 'aria-label': p.label },
      p.items.map(function (it) {
        return h('button', { key: it.value, role: 'tab', className: 'px-seg-item', 'aria-selected': value === it.value, onClick: function () { st[1](it.value); p.onChange && p.onChange(it.value); } },
          it.icon && h(Icon, { name: it.icon, size: 16 }), it.label, it.badge && h('span', { className: 'px-seg-badge' }, it.badge));
      }));
  }

  function TextField(p) {
    return h('label', { className: cx('px-field', p.size === 'lg' && 'px-field-lg') },
      p.icon && h(Icon, { name: p.icon, size: 18 }),
      h('input', { placeholder: p.placeholder, defaultValue: p.defaultValue, value: p.value, onChange: p.onChange, 'aria-label': p.label || p.placeholder, type: p.type || 'text' }));
  }

  function Chip(p) { return h('button', { type: 'button', className: 'px-chip', onClick: p.onClick }, p.icon && h(Icon, { name: p.icon, size: 16 }), p.children); }

  var TAG_ICON = { smartbook: 'book-marked', general: 'circle-alert', mastered: 'circle-check', severe: 'circle-x' };
  function Tag(p) {
    var tone = p.tone || 'neutral';
    return h('span', { className: cx('px-tag', 'px-tag-' + tone) }, (p.icon || TAG_ICON[tone]) && tone !== 'recommended' && h(Icon, { name: p.icon || TAG_ICON[tone], size: 12, strokeWidth: 2 }), p.children);
  }

  function CitationChip(p) {
    return h('button', { type: 'button', className: 'px-cite', onClick: p.onClick, title: 'Apri la fonte' }, h(Icon, { name: p.kind === 'pdf' ? 'book-open' : 'book-marked', size: 13, strokeWidth: 2 }), p.children);
  }

  function MasteryBar(p) {
    var v = Math.max(0, Math.min(100, p.value || 0)), t = p.target;
    return h('div', { className: 'px-mbar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': v, 'aria-label': p.label || 'Padronanza' },
      h('div', { className: 'px-mbar-track' },
        h('div', { className: cx('px-mbar-fill', p.tone === 'primary' && 'is-primary'), style: { width: v + '%' } }),
        p.tone !== 'primary' && h('div', { className: 'px-mbar-knob', style: { left: v + '%' } }),
        t != null && h('div', { className: 'px-mbar-target', style: { left: t + '%' }, title: 'Obiettivo ' + t + '%' })),
      p.showValue !== false && h('span', { className: 'px-mbar-value' }, v + '%'));
  }

  function PlanCard(p) {
    return h('article', { className: 'px-card px-plan' },
      h('div', { className: 'px-plan-top' },
        h('div', null, p.subject && h('div', { className: 'px-plan-subject' }, p.subject), h('h3', { className: 'px-plan-title' }, p.title)),
        h(MasteryBar, { value: p.mastery, target: p.target })),
      h('div', { className: 'px-plan-foot' },
        h('span', { className: 'px-plan-meta' }, p.meta),
        h(Button, { size: 'sm', onClick: p.onContinue }, p.cta || 'Continua')));
  }

  function StatTile(p) {
    return h('section', { className: 'px-card px-stat' },
      h('div', { className: 'px-stat-head' },
        h('div', null, h('div', { className: 'px-stat-label' }, p.label), h('div', { className: 'px-stat-num' }, p.value, h('small', null, p.unit || '%'))),
        h('div', { className: 'px-stat-pills' }, (p.pills || []).map(function (x, i) { return h('span', { key: i, className: 'px-pill-meta' }, x); }))),
      h(MasteryBar, { value: p.value, target: p.target, tone: 'primary', showValue: false }),
      p.stats && h('div', { className: 'px-stat-foot' }, p.stats.map(function (s, i) { return h('div', { key: i }, h('b', null, s.value), h('span', null, s.label)); })));
  }

  function LessonTile(p) {
    return h('button', { type: 'button', className: 'px-ltile', onClick: p.onClick },
      p.recommended && h('span', { className: 'px-tag px-tag-recommended' }, 'Consigliato'),
      p.count ? h('span', { className: 'px-ltile-count', 'aria-label': p.count + ' in attesa' }, p.count) : null,
      h('span', { className: 'px-ltile-ico' }, h(Icon, { name: p.icon, size: 20 })), p.label);
  }

  function PathNode(p) {
    var state = p.state || 'available';
    return h('div', { className: 'px-node-wrap' },
      h('button', { type: 'button', className: cx('px-node', 'is-' + state), disabled: state === 'locked', 'aria-label': p.label + (state === 'locked' ? ' (bloccato)' : state === 'done' ? ' (completato)' : state === 'current' ? ' (attuale)' : ''), title: state === 'locked' ? p.unlockHint : undefined },
        h(Icon, { name: state === 'locked' ? 'lock' : p.icon, size: 32, strokeWidth: 1.5 })),
      p.label && h('div', { className: 'px-node-label' }, p.label));
  }

  function GapItem(p) {
    return h('div', { className: 'px-card px-gap' },
      h('span', { className: cx('px-gap-dot', 'is-' + (p.severity || 'minor')) }),
      h('div', { className: 'px-gap-body' },
        h(Tag, { tone: p.severity === 'severe' ? 'severe' : 'general', icon: 'target' }, p.severity === 'severe' ? 'grave' : 'lieve'),
        h('p', { className: 'px-gap-text' }, p.children),
        h('span', { className: 'px-gap-topic' }, p.topic)),
      p.onFill && h(Button, { size: 'sm', variant: 'secondary', onClick: p.onFill }, 'Colma'));
  }

  function Composer(p) {
    var m = useState(p.mode || 'solver');
    return h('div', { className: 'px-composer' },
      h('div', { className: 'px-composer-top' },
        h('button', { type: 'button', className: 'px-subject' }, h(Icon, { name: 'graduation-cap', size: 14 }), p.subject || 'Nessuna materia'),
        (p.sources || []).map(function (s, i) { return h(Tag, { key: i, tone: 'smartbook' }, s); })),
      h('textarea', { placeholder: p.placeholder || 'Chiedi o allega un file', rows: 2, 'aria-label': 'Messaggio' }),
      h('div', { className: 'px-composer-bar' },
        h(IconButton, { icon: 'paperclip', label: 'Allega file o immagine', variant: 'ghost', size: 'sm' }),
        h(IconButton, { icon: 'signature', label: 'Lavagna', variant: 'ghost', size: 'sm' }),
        h(IconButton, { icon: 'sigma', label: 'Inserisci formula', variant: 'ghost', size: 'sm' }),
        h('div', { className: 'px-mode', role: 'group', 'aria-label': 'Modalità tutor' },
          h('button', { type: 'button', 'aria-pressed': m[0] === 'solver', onClick: function () { m[1]('solver'); } }, 'Risolutore'),
          h('button', { type: 'button', 'aria-pressed': m[0] === 'socratic', onClick: function () { m[1]('socratic'); } }, 'Socratico')),
        h('span', { className: 'px-spacer' }),
        p.streaming ? h(IconButton, { icon: 'square', label: 'Interrompi', variant: 'secondary', size: 'sm' }) : h(IconButton, { icon: 'send', label: 'Invia', variant: 'primary', size: 'sm' })));
  }

  function ChatMessage(p) {
    if (p.role === 'user') return h('div', { className: 'px-msg px-msg-user' }, h('div', { className: 'px-msg-bubble' }, p.children));
    return h('div', { className: 'px-msg' },
      h('span', { className: 'px-msg-avatar', 'aria-hidden': true }, h(Logo, { size: 22 })),
      h('div', { className: 'px-msg-body' },
        p.general && h('div', { style: { marginBottom: 8 } }, h(Tag, { tone: 'general' }, 'conoscenza generale, non dalle tue fonti')),
        h('p', { className: 'px-msg-text' }, p.children),
        h('div', { className: 'px-msg-foot' },
          h(IconButton, { icon: 'copy', label: 'Copia', variant: 'ghost', size: 'sm' }),
          h(IconButton, { icon: 'thumbs-up', label: 'Utile', variant: 'ghost', size: 'sm' }),
          h(IconButton, { icon: 'thumbs-down', label: 'Non utile', variant: 'ghost', size: 'sm' }),
          h(IconButton, { icon: 'refresh-cw', label: 'Rigenera', variant: 'ghost', size: 'sm' }),
          p.engine && h('span', { className: 'px-msg-engine' }, p.engine)),
        p.suggestions && h('div', { className: 'px-msg-chips' }, p.suggestions.map(function (s, i) { return h(Chip, { key: i }, s); }))));
  }

  var OPT_STATE = { correct: ['circle-check', 'Corretta'], wrong: ['circle-x', 'Sbagliata'] };
  function QuizOption(p) {
    var st = p.state || 'idle', o = OPT_STATE[st];
    return h('button', { type: 'button', className: cx('px-opt', st !== 'idle' && 'is-' + st), 'aria-pressed': st === 'selected', onClick: p.onClick },
      h('span', { className: 'px-opt-key' }, p.letter), h('span', { className: 'px-opt-text' }, p.children),
      o && h('span', { className: 'px-opt-state' }, h(Icon, { name: o[0], size: 16, strokeWidth: 2 }), o[1]));
  }

  var RATES = [['Impossibile', '1'], ['Difficile', '2'], ['Facile', '3'], ['Facilissima', '4']];
  function Flashcard(p) {
    var f = useState(!!p.flipped), flipped = f[0];
    var c = p.counters || { nuove: 12, apprendimento: 4, padroneggiate: 20 };
    return h('div', { className: 'px-fc' },
      h('div', { className: 'px-fc-counters' },
        h(Tag, { tone: 'smartbook', icon: 'layers' }, c.nuove + ' nuove'), h(Tag, { tone: 'general', icon: 'repeat' }, c.apprendimento + ' in apprendimento'), h(Tag, { tone: 'mastered' }, c.padroneggiate + ' padroneggiate')),
      h('div', { className: 'px-card px-fc-face', role: 'button', tabIndex: 0, 'aria-label': flipped ? 'Risposta' : 'Domanda, premi per girare', onClick: function () { f[1](!flipped); } },
        h('p', { className: 'px-fc-q' }, p.front),
        flipped ? h('p', { className: 'px-fc-a' }, p.back) : h('span', { className: 'px-fc-hint' }, 'clic o spazio per girare'),
        flipped && p.source && h(CitationChip, null, p.source)),
      flipped && h('div', { className: 'px-fc-rates' }, RATES.map(function (r) { return h('button', { key: r[1], type: 'button', className: 'px-fc-rate' }, r[0], h('kbd', null, r[1])); })));
  }

  var ENG_ICON = { cli: 'terminal', api: 'key-round', local: 'hard-drive', remote: 'cloud' };
  var STATUS = { ok: 'Pronto', warn: 'Accesso richiesto', error: 'Non raggiungibile', idle: 'Non testato' };
  function EngineRow(p) {
    var s = p.status || 'idle';
    return h('div', { className: 'px-card px-engine' },
      h('span', { className: 'px-engine-ico' }, h(Icon, { name: ENG_ICON[p.kind] || 'cpu', size: 18 })),
      h('div', { className: 'px-engine-main' }, h('div', { className: 'px-engine-name' }, p.name, p.isDefault && h('span', { style: { marginLeft: 8 } }, h(Tag, null, 'predefinito'))), h('div', { className: 'px-engine-model' }, p.model)),
      h('span', { className: cx('px-status', 'is-' + s) }, h('i', null), p.statusText || STATUS[s]),
      h(Button, { size: 'sm', variant: 'secondary' }, s === 'warn' ? 'Accedi' : 'Testa'));
  }

  window.Pyxis = Object.assign(window.Pyxis || {}, { Logo: Logo, Icon: Icon, Button: Button, IconButton: IconButton, SegmentedTabs: SegmentedTabs, TextField: TextField, Chip: Chip, Tag: Tag, CitationChip: CitationChip, MasteryBar: MasteryBar, PlanCard: PlanCard, StatTile: StatTile, LessonTile: LessonTile, PathNode: PathNode, GapItem: GapItem, Composer: Composer, ChatMessage: ChatMessage, QuizOption: QuizOption, Flashcard: Flashcard, EngineRow: EngineRow, ICON_NAMES: Object.keys(ICONS) });
})();
