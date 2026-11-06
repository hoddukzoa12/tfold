const { createElement: h, useEffect, useState } = React;

function usePath() {
	const [path, setPath] = useState(location.pathname);
	useEffect(() => {
		const update = () => setPath(location.pathname);
		addEventListener('popstate', update);
		return () => removeEventListener('popstate', update);
	}, []);
	return path;
}

function Link({ to, children }) {
	const go = (event) => {
		event.preventDefault();
		history.pushState(null, '', to);
		dispatchEvent(new PopStateEvent('popstate'));
	};
	return h('a', { href: to, onClick: go }, children);
}

function Home() {
	const [count, setCount] = useState(0);
	return h(
		'article',
		null,
		h('h1', null, 'A page that React owns'),
		h(
			'p',
			null,
			'React renders every paragraph on this page from state, so an extension that rewrites these nodes in place would fight the framework and lose.',
		),
		h(
			'p',
			{ id: 'counter-paragraph' },
			'This paragraph holds a live counter that React updates on every click, and right now the counter reads ',
			h('button', { id: 'counter', type: 'button', onClick: () => setCount((n) => n + 1) }, String(count)),
			' clicks, so a folded copy of it must keep showing the current value.',
		),
		h(
			'p',
			null,
			'The third paragraph is plain text with enough words to count as a block, and it never changes after the first render of the page.',
		),
	);
}

function About() {
	return h(
		'article',
		null,
		h('h1', null, 'A second route'),
		h(
			'p',
			null,
			'This route replaces every paragraph of the first page through client-side navigation, so the browser never loads a new document.',
		),
	);
}

function App() {
	const path = usePath();
	return h(
		'main',
		null,
		h('nav', null, h(Link, { to: '/react/' }, 'Home'), h(Link, { to: '/react/about' }, 'About')),
		path.startsWith('/react/about') ? h(About) : h(Home),
	);
}

ReactDOM.createRoot(document.getElementById('root')).render(h(React.StrictMode, null, h(App)));
