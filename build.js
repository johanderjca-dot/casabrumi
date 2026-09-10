// Compila src/app.jsx (JSX) a app.js (JS plano y minificado) para que index.html lo cargue
// como <script> normal, sin transpilar en vivo en el navegador con Babel.
//
// Por qué existe esto: antes index.html transpilaba su propio JSX en el navegador con
// @babel/standalone en cada carga (~500KB de JSX). En desktop no se notaba, pero en
// celulares ese parseo+transformación podía tardar varios segundos o agotar memoria,
// y como la pantalla se quedaba en blanco mientras tanto, parecía que "no abría".
//
// Uso: node build.js   (o "npm run build")
// Siempre que se edite src/app.jsx hay que correr esto antes de hacer commit/push —
// index.html ya NO contiene el código fuente, solo referencia a app.js compilado.

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { minify } = require('terser');

async function build() {
    const srcPath = path.join(__dirname, 'src', 'app.jsx');
    const outPath = path.join(__dirname, 'app.js');

    const source = fs.readFileSync(srcPath, 'utf8');

    const { code: transformed } = babel.transformSync(source, {
        presets: [['@babel/preset-react', { runtime: 'classic' }]],
        filename: 'app.jsx',
        compact: false,
    });

    const result = await minify(transformed, {
        compress: { passes: 1 },
        mangle: true,
    });

    if (result.error) throw result.error;

    fs.writeFileSync(outPath, result.code);

    const kb = n => (n / 1024).toFixed(1);
    console.log(`OK: src/app.jsx (${kb(source.length)}KB) -> app.js (${kb(result.code.length)}KB)`);
}

build().catch(err => { console.error('Build failed:', err); process.exit(1); });
