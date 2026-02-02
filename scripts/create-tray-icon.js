const sharp = require('sharp');
const path = require('path');

// Create a template icon for macOS menu bar
// Template icons should be black with alpha channel
// macOS will automatically apply the appropriate color based on the theme

async function createTrayIcon(size, outputName) {
    // Create an SVG play icon (triangle)
    const padding = Math.round(size * 0.15);
    const iconSize = size - (padding * 2);

    // Play triangle coordinates
    const x1 = padding + Math.round(iconSize * 0.2);
    const y1 = padding;
    const x2 = padding + Math.round(iconSize * 0.2);
    const y2 = padding + iconSize;
    const x3 = padding + iconSize;
    const y3 = padding + Math.round(iconSize / 2);

    const svg = `
        <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
            <polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="black"/>
        </svg>
    `;

    const outputPath = path.join(__dirname, '..', 'assets', outputName);

    await sharp(Buffer.from(svg))
        .png()
        .toFile(outputPath);

    console.log(`Created: ${outputPath}`);
}

async function main() {
    // macOS menu bar icons should be 18x18 (1x) and 36x36 (2x)
    await createTrayIcon(18, 'iconTemplate.png');
    await createTrayIcon(36, 'iconTemplate@2x.png');

    console.log('\nTemplate icons created successfully!');
    console.log('These icons will automatically adapt to light/dark mode on macOS.');
}

main().catch(console.error);
