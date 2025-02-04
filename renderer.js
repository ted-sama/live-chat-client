// connect socket to server
const { io } = require("socket.io-client");
// const socket = io("http://localhost:3000");
const socket = io("https://live-chat-back-dyfk.onrender.com");

const container = document.querySelector('.container');

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

const displayVideo = (src, text) => {
    const video = document.createElement('video');
    video.src = src;
    video.autoplay = true;
    video.loop = false;
    video.volume = 0.05;
    
    const caption = document.createElement('span');
    caption.className = 'caption';
    caption.innerText = text;

    container.appendChild(video);
    container.appendChild(caption);

    video.addEventListener('ended', () => {
        container.removeChild(video);
        container.removeChild(caption);
    });
}

socket.on("connect", () => {
    console.log("Connected to server with id", socket.id);
});

// listen for messages
socket.on("play", (item) => {
    console.log(item);
    if (item.type === "image") {
        displayImage(item.src, item.caption, 5000);
    } else {
        displayVideo(item.src, item.caption);
    }
});

// displayImage('assets/pas ryze devant morgane.gif', 'Niggie', 3000);
// displayVideo('assets/teddit.mp4', 'Niggie');