export const contrastProbe = `(() => {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const parse = (css) => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = '#000';
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
		return { r, g, b, a: a / 255 };
	};
	const over = (top, bottom) => ({
		r: top.r * top.a + bottom.r * (1 - top.a),
		g: top.g * top.a + bottom.g * (1 - top.a),
		b: top.b * top.a + bottom.b * (1 - top.a),
		a: 1,
	});
	const up = (el) => el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
	const canvasColor = { r: 255, g: 255, b: 255, a: 1 };
	const backdrop = (el, own) => {
		const layers = own ? [own] : [];
		for (let at = el; at; at = up(at)) {
			const color = parse(getComputedStyle(at).backgroundColor);
			if (color.a > 0) layers.push(color);
			if (color.a >= 1) break;
		}
		return layers.reverse().reduce((under, layer) => over(layer, under), canvasColor);
	};
	const opacity = (el) => {
		let value = 1;
		for (let at = el; at; at = up(at)) value *= Number(getComputedStyle(at).opacity);
		return value;
	};
	const channel = (value) => {
		const c = value / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
	const ratio = (a, b) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
	for (const animation of document.getAnimations()) if (animation instanceof CSSTransition) animation.finish();
	const seen = [];
	const check = (el, text, style, own) => {
		const bg = backdrop(el, own);
		const ink = parse(style.color);
		const fg = over({ ...ink, a: ink.a * opacity(el) }, bg);
		seen.push({ text: text.trim().replace(/\\s+/g, ' ').slice(0, 40), fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, size: parseFloat(style.fontSize) });
	};
	const walk = (root) => {
		for (const el of root.querySelectorAll('*')) {
			if (el.shadowRoot) walk(el.shadowRoot);
			if (!el.checkVisibility({ visibilityProperty: true })) continue;
			const own = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('');
			if (own.trim()) check(el, own, getComputedStyle(el));
			if (el instanceof HTMLInputElement && el.type !== 'radio') {
				if (el.value) check(el, el.value, getComputedStyle(el));
				else if (el.placeholder) check(el, el.placeholder, getComputedStyle(el, '::placeholder'));
			}
			const after = getComputedStyle(el, '::after');
			if (after.content.startsWith('"') && after.content.length > 2) {
				const own = parse(after.backgroundColor);
				check(el, after.content.slice(1, -1), after, own.a > 0 ? own : undefined);
			}
		}
	};
	walk(document);
	return seen;
})()`;

export type Pair = { text: string; fg: string; bg: string; ratio: number; size: number };
export const pairsOf = (all: Pair[]) => [...new Map(all.map((pair) => [`${pair.fg} on ${pair.bg}`, pair])).values()].sort((a, b) => a.ratio - b.ratio);
