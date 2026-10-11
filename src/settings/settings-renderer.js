const api = window.settings;

const elements = {
    form: document.getElementById('settings-form'),
    url: document.getElementById('url'),
    apiKey: document.getElementById('api-key'),
    apiKeyHelp: document.getElementById('api-key-help'),
    removeKeyRow: document.getElementById('remove-key-row'),
    removeKey: document.getElementById('remove-key'),
    status: document.getElementById('status'),
    test: document.getElementById('test'),
    cancel: document.getElementById('cancel'),
    save: document.getElementById('save'),
};

document.documentElement.dataset.platform = api.platform;

function setStatus(message, tone = null) {
    elements.status.textContent = message;
    if (tone) elements.status.dataset.tone = tone;
    else delete elements.status.dataset.tone;
}

async function load() {
    const { url, hasApiKey, encryptionAvailable } = await api.get();
    elements.url.value = url;
    elements.removeKeyRow.hidden = !hasApiKey;
    elements.apiKey.placeholder = hasApiKey ? 'Clé enregistrée' : 'Aucune';
    elements.apiKeyHelp.textContent = !encryptionAvailable
        ? 'Le chiffrement du système est indisponible : aucune clé ne peut être enregistrée.'
        : hasApiKey
            ? 'Laisse vide pour garder la clé actuelle. Elle est chiffrée par le système.'
            : 'Nécessaire seulement si le serveur en exige une. Elle sera chiffrée par le système.';
    elements.apiKey.disabled = !encryptionAvailable;
    elements.url.focus();
}

elements.removeKey.addEventListener('change', () => {
    elements.apiKey.disabled = elements.removeKey.checked;
    if (elements.removeKey.checked) elements.apiKey.value = '';
});

elements.test.addEventListener('click', async () => {
    elements.test.disabled = true;
    setStatus('Test en cours…');
    const result = await api.test(elements.url.value);
    setStatus(result.message, result.ok ? 'ok' : 'error');
    elements.test.disabled = false;
});

elements.cancel.addEventListener('click', () => api.close());

elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.save.disabled = true;
    const result = await api.save({
        url: elements.url.value,
        apiKey: elements.apiKey.value,
        removeApiKey: elements.removeKey.checked,
    });
    if (!result.ok) {
        setStatus(result.message, 'error');
        elements.save.disabled = false;
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') api.close();
});

load();
