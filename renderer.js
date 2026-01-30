const { ipcRenderer } = require("electron");

// connect socket to server
const { io } = require("socket.io-client");
// const socket = io("http://localhost:3000");
const socket = io("https://live-chat-back-dyfk.onrender.com");


const container = document.querySelector('.container');
container.className = 'container default';

let isMuted = false;

const displayImage = (src, text, duration) => {
    const image = document.createElement('img');
    image.src = src;

    const caption = document.createElement('span');
    caption.className = 'caption';
    caption.innerText = text;

    container.appendChild(image);
    container.appendChild(caption);

    setTimeout(() => {
        container.removeChild(image);
        container.removeChild(caption);
    }, duration);
}

const displayVideo = (src, text, duration=0) => {
    const video = document.createElement('video');
    video.src = src;
    video.autoplay = true;
    video.loop = false;
    video.volume = isMuted ? 0 : 0.05;
    
    const caption = document.createElement('span');
    caption.className = 'caption';
    caption.innerText = text;

    container.appendChild(video);
    container.appendChild(caption);

    if (duration > 0) {
        setTimeout(() => {
            container.removeChild(video);
            container.removeChild(caption);
        }, duration);
    } else {
        video.addEventListener('ended', () => {
            container.removeChild(video);
            container.removeChild(caption);
        });
    }
}

socket.on("connect", () => {
    console.log("Connected to server with id", socket.id);
});

// listen for messages
socket.on("play", (item) => {
    console.log(item);
    if (item.type === "image") {
        displayImage(item.src, item.caption, item.duration);
    } else {
        displayVideo(item.src, item.caption, item.duration);
    }
});

ipcRenderer.on('update-position', (event, position) => {
    container.className = `container ${position}`;
});

ipcRenderer.on('set-muted', (event, muted) => {
    isMuted = muted;
    // Update volume on any currently playing videos
    const videos = container.querySelectorAll('video');
    videos.forEach(video => {
        video.volume = isMuted ? 0 : 0.05;
    });
});

// app updates
ipcRenderer.on('update_available', () => {
    alert('Une nouvelle mise à jour est disponible ! Elle sera téléchargée.');
});

ipcRenderer.on('update_downloaded', () => {
    const confirmUpdate = confirm('Mise à jour prête ! Redémarrer maintenant ?');
    if (confirmUpdate) {
        ipcRenderer.send('restart_app');
    }
});