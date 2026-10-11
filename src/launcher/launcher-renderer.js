const SEARCH_DEBOUNCE_MS = 120;
const DURATION_PRESETS = [
    { label: '3 s', seconds: 3 },
    { label: '5 s', seconds: 5 },
    { label: '10 s', seconds: 10 },
    { label: '30 s', seconds: 30 },
    { label: 'Complète', seconds: 0 },
];
const DEFAULT_IMAGE_SECONDS = 5;

const api = window.liveChat;
const isMac = api.platform === 'darwin';

const elements = {
    launcher: document.getElementById('launcher'),
    query: document.getElementById('query'),
    results: document.getElementById('results'),
    preview: document.getElementById('preview'),
    previewMedia: document.getElementById('preview-media'),
    previewName: document.getElementById('preview-name'),
    previewMeta: document.getElementById('preview-meta'),
    form: document.getElementById('send-form'),
    caption: document.getElementById('caption'),
    durations: document.getElementById('durations'),
    durationHint: document.getElementById('duration-hint'),
    sendError: document.getElementById('send-error'),
    sendSettings: document.getElementById('send-settings'),
    sendButton: document.getElementById('send-button'),
    notice: document.getElementById('notice'),
    noticeText: document.getElementById('notice-text'),
    noticeAction: document.getElementById('notice-action'),
    status: document.getElementById('status'),
};

const state = {
    library: null,
    results: [],
    selectedIndex: 0,
    durationSeconds: DEFAULT_IMAGE_SECONDS,
    requestId: 0,
    searching: false,
    sending: false,
};

const numberFormat = new Intl.NumberFormat('fr-FR');
const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

document.documentElement.dataset.platform = api.platform;
document.getElementById('mod-key').textContent = isMac ? '⌘' : 'Ctrl';

function formatClock(totalSeconds) {
    const seconds = Math.round(totalSeconds);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${numberFormat.format(Math.max(1, Math.round(bytes / 1024)))} Ko`;
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} Mo`;
}

function isPlayedAsVideo(result) {
    return result.kind === 'video';
}

function selectedResult() {
    return state.results[state.selectedIndex] ?? null;
}

function groupResults(results, isRecent) {
    if (isRecent) return [{ label: 'Récents', items: results }];

    const groups = [
        { label: 'Vidéos', items: results.filter(isPlayedAsVideo) },
        { label: 'Images', items: results.filter((result) => !isPlayedAsVideo(result)) },
    ].filter((group) => group.items.length > 0);
    return groups.sort((a, b) => b.items[0].score - a.items[0].score);
}

// The list is rendered in display order, so selection indexes follow what the user sees.
function renderResults(isRecent) {
    const groups = groupResults(state.results, isRecent);
    state.results = groups.flatMap((group) => group.items);

    const fragment = document.createDocumentFragment();
    let index = 0;
    for (const group of groups) {
        const label = document.createElement('div');
        label.className = 'results__section';
        label.textContent = group.label;
        label.setAttribute('role', 'presentation');
        fragment.append(label);

        for (const result of group.items) {
            fragment.append(createRow(result, index++));
        }
    }
    elements.results.replaceChildren(fragment);
}

function createRow(result, index) {
    const row = document.createElement('div');
    row.className = 'result';
    row.id = `result-${index}`;
    row.dataset.index = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === state.selectedIndex));

    const thumb = document.createElement('img');
    thumb.className = 'result__thumb';
    thumb.src = result.thumbUrl;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';

    const text = document.createElement('div');
    text.className = 'result__text';
    const name = document.createElement('span');
    name.className = 'result__name';
    name.textContent = result.name;
    const folder = document.createElement('span');
    folder.className = 'result__folder';
    folder.textContent = result.folder;
    text.append(name, folder);

    row.append(thumb, text);

    if (result.tooLarge) {
        row.append(createBadge('Trop lourd', 'badge badge--danger'));
    } else if (isPlayedAsVideo(result) && result.durationMs) {
        row.append(createBadge(formatClock(result.durationMs / 1000), 'badge'));
    } else if (result.animated) {
        row.append(createBadge('GIF', 'badge'));
    }
    return row;
}

function createBadge(text, className) {
    const badge = document.createElement('span');
    badge.className = className;
    badge.textContent = text;
    return badge;
}

function updateSelection(nextIndex, { scroll = true } = {}) {
    if (state.results.length === 0) return;
    const clamped = Math.max(0, Math.min(state.results.length - 1, nextIndex));
    const previous = elements.results.querySelector('[aria-selected="true"]');
    previous?.setAttribute('aria-selected', 'false');

    state.selectedIndex = clamped;
    const row = document.getElementById(`result-${clamped}`);
    row?.setAttribute('aria-selected', 'true');
    elements.query.setAttribute('aria-activedescendant', row ? row.id : '');
    if (scroll) row?.scrollIntoView({ block: 'nearest' });
    renderPreview();
}

function renderDurations(result) {
    const buttons = DURATION_PRESETS.map((preset, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
        button.textContent = preset.label;
        button.title = `${isMac ? '⌘' : 'Ctrl+'}${index + 1}`;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(preset.seconds === state.durationSeconds));
        button.addEventListener('click', () => setDuration(preset.seconds));
        return button;
    });
    elements.durations.replaceChildren(...buttons);

    const mediaSeconds = result?.durationMs ? result.durationMs / 1000 : null;
    let hint = '';
    if (result && isPlayedAsVideo(result) && mediaSeconds && state.durationSeconds > 0) {
        hint = state.durationSeconds < mediaSeconds
            ? `La vidéo sera coupée à ${formatClock(state.durationSeconds)} sur ${formatClock(mediaSeconds)}.`
            : `La vidéo (${formatClock(mediaSeconds)}) restera affichée ${formatClock(state.durationSeconds)}.`;
    }
    elements.durationHint.textContent = hint;
}

function setDuration(seconds) {
    state.durationSeconds = seconds;
    renderDurations(selectedResult());
}

function renderPreview() {
    const result = selectedResult();
    elements.preview.hidden = !result;
    elements.sendError.textContent = '';
    elements.sendSettings.hidden = true;
    if (!result) return;

    if (elements.previewMedia.dataset.id !== result.id) {
        elements.previewMedia.dataset.id = result.id;
        const media = isPlayedAsVideo(result) ? document.createElement('video') : document.createElement('img');
        if (media instanceof HTMLVideoElement) {
            Object.assign(media, { muted: true, loop: true, autoplay: true, playsInline: true, poster: result.thumbUrl });
        } else {
            media.alt = result.name;
            media.decoding = 'async';
        }
        media.src = result.fileUrl;
        elements.previewMedia.replaceChildren(media);
        state.durationSeconds = isPlayedAsVideo(result) ? 0 : DEFAULT_IMAGE_SECONDS;
    }

    elements.previewName.textContent = result.name;
    const kindLabel = isPlayedAsVideo(result) ? 'Vidéo' : result.animated ? 'GIF animé' : 'Image';
    const parts = [kindLabel, formatSize(result.size), dateFormat.format(new Date(result.mtimeMs))];
    if (isPlayedAsVideo(result) && result.durationMs) parts.push(formatClock(result.durationMs / 1000));
    elements.previewMeta.textContent = parts.join(' · ');

    renderDurations(result);
    elements.sendButton.disabled = result.tooLarge || state.sending;
    if (result.tooLarge) elements.sendError.textContent = 'Fichier trop lourd pour être envoyé (90 Mo max).';
}

function renderNotice() {
    const library = state.library;
    let text = null;
    let action = null;
    // Recent files need no model, so loading states only take over once there is a query to answer.
    const needsModel = Boolean(elements.query.value.trim()) || library?.indexed === 0;

    if (!library) {
        text = 'Chargement…';
    } else if (library.folders === 0) {
        text = 'Ajoute un dossier de memes pour commencer.';
        action = { label: 'Ajouter un dossier…', run: () => api.addFolder() };
    } else if (needsModel && library.status === 'downloading' && library.download) {
        const percent = Math.floor((library.download.loaded / library.download.total) * 100);
        text = `Téléchargement du modèle de recherche : ${percent} %. Cela n’arrive qu’une fois.`;
    } else if (needsModel && library.status === 'loading') {
        text = 'Chargement du modèle de recherche…';
    } else if (library.status === 'error') {
        text = `La recherche est indisponible : ${library.error}`;
    } else if (library.indexed === 0) {
        text = library.paused
            ? 'L’indexation est en pause et aucun média n’est encore indexé.'
            : 'Indexation des premiers médias en cours…';
    } else if (state.results.length === 0 && !state.searching && elements.query.value.trim()) {
        text = `Aucun résultat pour « ${elements.query.value.trim()} ».`;
    }

    elements.notice.hidden = text === null;
    elements.noticeText.textContent = text ?? '';
    elements.noticeAction.hidden = !action;
    if (action) {
        elements.noticeAction.textContent = action.label;
        elements.noticeAction.onclick = action.run;
    }
}

function renderStatus() {
    const library = state.library;
    if (!library) return;
    const parts = [];
    if (elements.query.value.trim()) parts.push(`${numberFormat.format(state.results.length)} résultats`);
    parts.push(`${numberFormat.format(library.indexed)} médias indexés`);
    if (library.pending > 0) {
        const total = numberFormat.format(library.indexed + library.pending);
        parts.push(library.paused ? `indexation en pause (${numberFormat.format(library.indexed)} / ${total})` : `indexation ${numberFormat.format(library.indexed)} / ${total}`);
    }
    if (library.device) parts.push(library.device === 'webgpu' ? 'GPU' : 'CPU');
    elements.status.textContent = parts.join(' · ');
}

let searchTimer = null;

function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

async function runSearch() {
    const query = elements.query.value;
    const requestId = ++state.requestId;
    state.searching = true;
    try {
        const results = await api.search(query);
        if (requestId !== state.requestId) return;
        state.results = results;
        state.selectedIndex = 0;
        renderResults(!query.trim());
        updateSelection(0);
    } catch (error) {
        if (requestId !== state.requestId) return;
        state.results = [];
        elements.results.replaceChildren();
        renderPreview();
        console.error(error);
    } finally {
        if (requestId === state.requestId) {
            state.searching = false;
            renderNotice();
            renderStatus();
        }
    }
}

async function send() {
    const result = selectedResult();
    if (!result || result.tooLarge || state.sending) return;

    state.sending = true;
    elements.sendButton.disabled = true;
    elements.sendButton.textContent = 'Envoi…';
    elements.sendError.textContent = '';
    elements.sendSettings.hidden = true;
    try {
        const outcome = await api.send(result.id, { caption: elements.caption.value.trim(), durationMs: state.durationSeconds * 1000 });
        if (outcome.ok) {
            elements.caption.value = '';
        } else {
            elements.sendError.textContent = outcome.message;
            elements.sendSettings.hidden = outcome.action !== 'settings';
        }
    } catch (error) {
        elements.sendError.textContent = 'Envoi impossible.';
        console.error(error);
    } finally {
        state.sending = false;
        elements.sendButton.textContent = 'Envoyer';
        elements.sendButton.disabled = Boolean(selectedResult()?.tooLarge);
    }
}

function applyLibraryState(library) {
    const wasReady = state.library?.status === 'ready' && state.library?.indexed > 0;
    state.library = library;
    if (library.accentColor) document.documentElement.style.setProperty('--accent', library.accentColor);
    renderNotice();
    renderStatus();
    const isReady = library.status === 'ready' && library.indexed > 0;
    if (isReady && !wasReady) scheduleSearch();
}

elements.query.addEventListener('input', scheduleSearch);

elements.results.addEventListener('mousedown', (event) => event.preventDefault());
elements.results.addEventListener('click', (event) => {
    const row = event.target.closest('.result');
    if (row) updateSelection(Number(row.dataset.index), { scroll: false });
});
elements.results.addEventListener('dblclick', (event) => {
    if (event.target.closest('.result')) send();
});

elements.sendSettings.addEventListener('click', () => api.openSettings());

elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
});

document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        updateSelection(state.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1));
        return;
    }
    if (event.key === 'Enter') {
        if (event.target instanceof HTMLButtonElement && !mod) return;
        event.preventDefault();
        const result = selectedResult();
        if (mod && result) api.reveal(result.id);
        else if (!mod) send();
        return;
    }
    if (mod && /^[1-5]$/.test(event.key)) {
        event.preventDefault();
        setDuration(DURATION_PRESETS[Number(event.key) - 1].seconds);
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        if (document.activeElement === elements.caption) {
            elements.query.focus();
        } else if (elements.query.value) {
            elements.query.value = '';
            scheduleSearch();
        } else {
            api.hide();
        }
    }
});

api.onShown((library) => {
    elements.launcher.classList.remove('is-appearing');
    void elements.launcher.offsetWidth;
    elements.launcher.classList.add('is-appearing');

    applyLibraryState(library);
    elements.query.focus();
    elements.query.select();
    scheduleSearch();
});

api.onStateChange(applyLibraryState);

api.getState().then(applyLibraryState);
