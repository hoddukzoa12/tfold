const { createElement: h, useEffect, useState } = React;

const base = '/x-like/';
const rowHeight = 320;
const headerHeight = 53;
const pool = 6;
const theme = new URLSearchParams(location.search).get('theme');
if (theme) document.documentElement.dataset.theme = theme;

const at = (handle) => ({ at: handle });
const tag = (name) => ({ tag: name });
const emoji = (char) => ({ emoji: char });
const url = (to, text) => ({ url: to, text });

const people = {
	jiwoo: { name: '한지우', handle: 'jiwoo_reads' },
	sam: { name: 'Sam Ortega', handle: 'sam_bakes' },
	minseo: { name: '박민서', handle: 'minseo_walks' },
	lena: { name: 'Lena Brooks', handle: 'lena_rides' },
};

const cleanupShort =
	'Here is the long version of my notes from the neighborhood cleanup on Saturday, because a few people asked how we organized it. We split into four teams, one for each block, and every team carried two bags, a pair of gloves for each person, and a printed map…';
const cleanupFull =
	'Here is the long version of my notes from the neighborhood cleanup on Saturday, because a few people asked how we organized it. We split into four teams, one for each block, and every team carried two bags, a pair of gloves for each person, and a printed map of the drains that clog first after rain. The team near the school found the most litter, mostly bottle caps and wrappers caught under the hedges. By noon we had filled thirty-one bags, and the city truck took them away within the hour. Next month we want to add a fifth team for the park, so reply here if you can join us.';

const posts = [
	{ id: 1, user: 'jiwoo', lang: 'ko', time: '2시간', parts: ['오늘 아침에 동네 빵집에서 갓 구운 소금빵을 샀는데 줄이 가게 밖까지 길게 늘어서 있었다. 기다리는 동안 옆 사람과 어떤 빵이 제일 맛있는지 이야기를 나눴고, 다들 크루아상을 추천했다. 다음 주에는 조금 더 일찍 가서 크루아상도 꼭 먹어 볼 생각이다.'] },
	{ id: 2, user: 'sam', lang: 'en', time: '3h', parts: ['Spent the morning repotting the basil with ', at('mina_gardens'), ' and the ', tag('windowsill'), ' herbs finally have room to grow. The old pots were cracked along the rim, so we swapped them for clay ones with proper drainage holes. Fingers crossed the roots settle in by next week ', emoji('🌱')] },
	{ id: 3, user: 'minseo', lang: 'ko', time: '4시간', parts: ['퇴근길 지하철에서 읽던 소설을 드디어 다 읽었는데 마지막 장면이 너무 조용하게 끝나서 한참 동안 멍하니 창밖만 바라봤다. 주인공이 오래된 편지를 태우는 장면은 처음부터 다시 읽고 싶을 만큼 좋았다. 이번 주말에는 같은 작가의 첫 번째 책을 찾아볼 계획이다.'] },
	{ id: 4, user: 'lena', lang: 'en', time: '5h', short: cleanupShort, parts: [cleanupFull] },
	{ id: 5, user: 'jiwoo', lang: 'ko', time: '6시간', parts: ['주말 라이딩 사진 올렸어요 ', url('photos/river-loop', 'example.com/photos/river-loop'), ' ', url('maps/han-river', 'example.com/maps/han-river'), ' ', tag('한강'), ' ', tag('자전거'), ' ', tag('노을'), ' ', tag('주말라이딩'), ' ', tag('서울'), ' ', at('minseo_walks'), ' ', at('lena_rides')] },
	{ id: 6, user: 'sam', lang: 'en', time: '7h', parts: ['Our team shipped the new search page today after six weeks of small fixes and long code reviews. The biggest change is that results now load while you type instead of after you press enter. Thanks to everyone who tested the early builds and sent screenshots.'] },
	{ id: 7, user: 'minseo', lang: 'ko', time: '8시간', parts: ['회사 근처에 새로 생긴 작은 도서관에 처음 가 봤는데 창가 자리마다 콘센트가 있어서 노트북을 들고 가기에 딱 좋았다. 오후에는 동네 어르신들이 모여서 신문을 읽고 계셨고, 아이들을 위한 그림책 코너도 따로 있었다. 점심시간마다 들러야겠다.'] },
	{ id: 8, user: 'lena', lang: 'en', time: '9h', parts: ['Reading list for the train this week: a short history of bridges, a novel about a lighthouse keeper, and a collection of essays on walking in cities. I keep a paper notebook for quotes because my phone battery never lasts the whole commute. Recommendations welcome.'] },
	{ id: 9, user: 'jiwoo', lang: 'ko', time: '10시간', parts: ['베란다에서 키우는 방울토마토가 올해 처음으로 빨갛게 익어서 아이와 함께 하나씩 따서 먹어 봤다. 마트에서 산 것보다 껍질은 조금 두꺼웠지만 훨씬 달고 향이 진했다. 내년에는 화분을 두 개 더 늘려서 상추와 고추도 함께 길러 볼 생각이다 ', emoji('🍅')] },
	{ id: 10, user: 'sam', lang: 'en', time: '11h', parts: ['Tried a new bread recipe that uses an overnight rise in the fridge, and the crust came out darker and crunchier than any loaf I baked before. The trick seems to be a very hot oven and a tray of water on the bottom rack. Will post photos tomorrow.'] },
	{ id: 11, user: 'minseo', lang: 'ko', time: '12시간', parts: ['어제 저녁에 처음으로 김치찌개를 혼자 끓여 봤는데 엄마가 알려 준 대로 돼지고기를 먼저 볶았더니 국물 맛이 훨씬 깊어졌다. 두부를 너무 일찍 넣어서 조금 부서진 것만 빼면 꽤 성공적이었다. 다음에는 참치 김치찌개에도 도전해 볼 생각이다.'] },
	{ id: 12, user: 'lena', lang: 'en', time: '13h', parts: ['The bike lane on the river road reopened this morning, and it is wider than before with a low curb between riders and cars. I rode the whole loop before work and only had to stop twice at the new crossings. Small changes like this make the city feel calmer.'] },
	{ id: 13, user: 'jiwoo', lang: 'ko', time: '14시간', parts: ['오랜만에 고향 바닷가에 내려가서 새벽에 일출을 보러 나갔는데 구름 사이로 해가 천천히 올라오는 모습이 정말 아름다웠다. 바닷바람이 차가워서 손이 시렸지만 따뜻한 커피 한 잔으로 버틸 수 있었다. 사진보다 눈으로 본 장면이 훨씬 오래 기억에 남을 것 같다.'] },
	{ id: 14, user: 'sam', lang: 'en', time: '15h', parts: ['Friendly reminder that the community library extends its hours during exam season, staying open until ten every weeknight through the end of the month. The quiet room on the second floor has new desk lamps and more power outlets now. Bring your own snacks.'] },
	{ id: 15, user: 'minseo', lang: 'ko', time: '16시간', parts: ['요즘 매일 아침 삼십 분씩 동네 공원을 걷기 시작했는데 일주일이 지나니 잠도 더 잘 오고 오후에 덜 피곤하다. 같은 시간에 걷는 강아지 산책 모임 사람들과도 이제 인사를 나누는 사이가 됐다. 비가 오는 날에는 우산을 쓰고라도 계속 걸어 볼 생각이다.'] },
	{ id: 16, user: 'lena', lang: 'en', time: '17h', parts: ['Watched the sunrise from the hill behind the old water tower and counted at least nine hot air balloons drifting over the valley. The air was cold enough to see my breath, but the view was worth the early alarm. Going back next weekend with a thermos.'] },
];

function emojiSrc(char) {
	return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><text x="0" y="30" font-size="30">${char}</text></svg>`)}`;
}

function go(to) {
	history.pushState(null, '', to);
	dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
	const [path, setPath] = useState(location.pathname);
	useEffect(() => {
		const update = () => setPath(location.pathname);
		addEventListener('popstate', update);
		return () => removeEventListener('popstate', update);
	}, []);
	return path;
}

function Link({ to, children, className }) {
	const follow = (event) => {
		event.preventDefault();
		go(to);
	};
	return h('a', { href: to, className, onClick: follow }, children);
}

function part(piece, i) {
	if (typeof piece === 'string') return h('span', { key: i, className: 't' }, piece);
	if (piece.url) return h('span', { key: i }, h(Link, { to: `${base}${piece.url}` }, piece.text));
	if (piece.tag) return h('span', { key: i }, h(Link, { to: `${base}hashtag/${encodeURIComponent(piece.tag)}` }, `#${piece.tag}`));
	if (piece.at) return h('div', { key: i, className: 'mention' }, h('span', null, h(Link, { to: `${base}${piece.at}` }, `@${piece.at}`)));
	return h('img', { key: i, className: 'emoji', alt: piece.emoji, draggable: false, src: emojiSrc(piece.emoji) });
}

function PostText({ post, expanded }) {
	const pieces = post.short && !expanded ? [post.short] : post.parts;
	const style = theme === 'dark-block' ? { color: '#e7e9ea' } : undefined;
	return h('div', { 'data-testid': 'tweetText', className: 'tweet-text', lang: post.lang, dir: 'auto', style }, pieces.map(part));
}

function Post({ post, hidden, expanded, onHide, onExpand }) {
	const user = people[post.user];
	const open = (event) => {
		if (!event.target.closest('a, button')) go(`${base}status/${post.id}`);
	};
	return h(
		'article',
		{ 'data-testid': 'tweet', 'data-post': post.id, role: 'article', tabIndex: 0, onClick: open },
		h('div', { className: 'user' }, h('span', { className: 'name' }, user.name), h('span', { className: 'handle' }, `@${user.handle} · ${post.time}`)),
		hidden ? h('div', { className: 'notice' }, 'You hid this post.') : h(PostText, { post, expanded }),
		!hidden && post.short && !expanded
			? h('button', { type: 'button', className: 'show-more', 'data-testid': 'tweet-text-show-more-link', onClick: () => onExpand(post.id) }, 'Show more')
			: null,
		h(
			'div',
			{ role: 'group', className: 'actions', 'aria-label': 'Post actions' },
			h('button', { type: 'button', 'data-testid': 'reply' }, '12'),
			h('button', { type: 'button', 'data-testid': 'like' }, '48'),
			h('button', { type: 'button', 'data-testid': 'caret', 'aria-label': 'Hide this post', onClick: () => onHide(post.id) }, 'Hide'),
		),
	);
}

function Timeline({ hidden, expanded, onHide, onExpand }) {
	const [first, setFirst] = useState(0);
	useEffect(() => {
		const update = () => setFirst(Math.max(0, Math.floor((scrollY - headerHeight) / rowHeight) - 1));
		update();
		addEventListener('scroll', update, { passive: true });
		return () => removeEventListener('scroll', update);
	}, []);
	const cells = [];
	for (let index = first; index < Math.min(posts.length, first + pool); index++) {
		const post = posts[index];
		cells.push(
			h(
				'div',
				{ key: index % pool, 'data-testid': 'cellInnerDiv', className: 'cell', style: { height: `${rowHeight}px`, transform: `translateY(${index * rowHeight}px)` } },
				h(Post, { post, hidden: hidden.has(post.id), expanded: expanded.has(post.id), onHide, onExpand }),
			),
		);
	}
	return h('section', { 'aria-label': 'Timeline: Your Home Timeline' }, h('div', { style: { position: 'relative', height: `${posts.length * rowHeight}px` } }, cells));
}

function Detail({ id }) {
	const post = posts.find((candidate) => String(candidate.id) === id);
	if (!post) return h('div', { className: 'detail' }, 'This post does not exist.');
	return h('div', { className: 'detail', 'data-testid': 'detail' }, h(Link, { to: base }, 'Back'), h(Post, { post, hidden: false, expanded: true, onHide() {}, onExpand() {} }));
}

function Primary({ path, hidden, expanded, onHide, onExpand }) {
	const rest = path.slice(base.length);
	if (rest.startsWith('status/')) return [h('h2', { key: 'h' }, 'Post'), h(Detail, { key: 'd', id: rest.slice('status/'.length) })];
	if (rest.startsWith('hashtag/')) {
		const name = decodeURIComponent(rest.slice('hashtag/'.length));
		return [h('h2', { key: 'h' }, `#${name}`), h('div', { key: 'd', className: 'detail', 'data-testid': 'hashtag' }, `Posts about #${name}`)];
	}
	if (rest !== '') return [h('h2', { key: 'h' }, `@${rest}`), h('div', { key: 'd', className: 'detail', 'data-testid': 'profile' }, `Profile of @${rest}`)];
	return [h('h2', { key: 'h' }, 'Home'), h(Timeline, { key: 't', hidden, expanded, onHide, onExpand })];
}

function Left() {
	return h(
		'header',
		{ role: 'banner', className: 'left' },
		h(
			'nav',
			{ 'aria-label': 'Primary' },
			['Home', 'Explore', 'Notifications', 'Messages', 'Bookmarks', 'Profile'].map((label) => h(Link, { key: label, to: base }, h('span', null, label))),
			h('div', { className: 'nav-tip', 'data-p5d': 'nav' }, h('span', null, 'Tip: every list, bookmark and community that you follow lives under the More menu in this column.')),
		),
		h(
			'button',
			{ type: 'button', className: 'post-button' },
			h('div', { 'data-p5d': 'button' }, h('span', null,'Write a new post for everyone who follows you, with photos, polls and a time to publish it later.')),
		),
	);
}

function Sidebar() {
	return h(
		'div',
		{ className: 'sidebar', 'data-testid': 'sidebarColumn' },
		h(
			'div',
			{ className: 'box composer', role: 'textbox', contentEditable: true, suppressContentEditableWarning: true, 'data-p5d': 'editable' },
			h('span', null, 'A draft that the reader is still writing in the composer, long enough to count as a paragraph of text.'),
		),
		h(
			'div',
			{ className: 'box', role: 'button', tabIndex: 0, 'data-testid': 'UserCell' },
			h('div', { className: 'name' }, h('span', null, 'Lena Brooks')),
			h('div', { 'data-p5d': 'role-button' }, h('span', null, 'Rides a bike to work in every season and writes about city streets, bridges and the people who keep them running.')),
		),
		h(
			'div',
			{ className: 'box muted', 'aria-hidden': 'true' },
			h('div', { 'data-p5d': 'aria-hidden' }, h('span', null, 'Decorative text that assistive technology skips, written long enough here to count as a whole paragraph.')),
		),
		h(
			'div',
			{ className: 'box', role: 'menu' },
			h('div', { role: 'menuitem', 'data-p5d': 'menu' }, h('span', null, 'Mute this conversation so that new replies to it never show up in your notifications again.')),
		),
		h(
			'div',
			{ className: 'box', role: 'toolbar' },
			h('div', { 'data-p5d': 'toolbar' }, h('span', null, 'Share, bookmark or copy the link to this post, and choose who can reply to it from here.')),
		),
		h(
			'section',
			{ className: 'box', 'aria-labelledby': 'trends-title' },
			h('h3', { id: 'trends-title' }, 'Trends for you'),
			h(
				'div',
				{ 'data-p5d': 'trends' },
				['한강', 'harbormarket', 'rainydays', 'bookclub', '소금빵', 'citybikes', 'sourdough', 'lanternnight', '퇴근길', 'gardening', 'riverloop', 'weekendride'].map((name) =>
					h(Link, { key: name, to: `${base}hashtag/${encodeURIComponent(name)}` }, h('span', null, `#${name} `)),
				),
			),
			h(
				'div',
				{ 'data-testid': 'trend', role: 'link', tabIndex: 0 },
				h('div', { className: 'muted' }, h('span', null, 'Sports · Trending')),
				h('div', { 'data-p5d': 'trend' }, h('span', null, 'The city marathon moves to Sunday morning after the storm warning for Saturday, and the route stays the same.')),
			),
		),
		h(
			'aside',
			{ className: 'box', 'aria-label': 'Who to follow' },
			h('h3', null, 'Who to follow'),
			h(
				'div',
				{ 'data-p5d': 'who-to-follow' },
				h(Link, { to: `${base}harbor_notes` }, h('span', null, 'Harbor Notes')),
				h('span', null, ' writes a weekly letter about the fish market, the ferries and the people who keep the old quay running.'),
			),
		),
		h(
			'nav',
			{ 'aria-label': 'Footer', className: 'muted' },
			h('div', { 'data-p5d': 'footer-nav' }, h('span', null, 'Terms of Service, Privacy Policy, Cookie Policy, Accessibility, Ads info and more links for this fixture page.')),
		),
	);
}

function App() {
	const path = usePath();
	const [hidden, setHidden] = useState(() => new Set());
	const [expanded, setExpanded] = useState(() => new Set());
	const onHide = (id) => setHidden((ids) => new Set(ids).add(id));
	const onExpand = (id) => setExpanded((ids) => new Set(ids).add(id));
	return h(
		'div',
		{ className: 'app' },
		h(Left),
		h('main', { role: 'main' }, h('div', { className: 'primary', 'data-testid': 'primaryColumn' }, h(Primary, { path, hidden, expanded, onHide, onExpand })), h(Sidebar)),
	);
}

ReactDOM.createRoot(document.getElementById('react-root')).render(h(React.StrictMode, null, h(App)));
