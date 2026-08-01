// Handles rendering + pagination for both PDF (pdf.js) and EPUB (epub.js) books.
const InkReader = (() => {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';
  }

  let mode = null;            // 'pdf' | 'epub'
  let orientation = 'horizontal';
  let theme = 'light';
  let surfaceEl = null;

  // pdf state
  let pdfDoc = null;
  let pageNum = 1;
  let pageCount = 0;
  let pdfObserver = null;

  // epub state
  let epubBook = null;
  let epubRendition = null;
  let locationsReady = false;

  let callbacks = {};

  function fireProgress(fraction, atEnd, locationValue) {
    if (callbacks.onProgress) callbacks.onProgress(fraction, atEnd, locationValue);
  }

  // Renders a pdf.js page into `canvas` at native screen resolution instead of
  // 1 canvas-pixel-per-CSS-pixel, which otherwise looks blurry on HiDPI/Retina
  // displays (the browser has to upscale the bitmap to fill the CSS box).
  function renderPageToCanvas(page, viewport, canvas) {
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    return page.render({ canvasContext: canvas.getContext('2d'), viewport, transform }).promise;
  }

  async function open(book, opts) {
    close();
    surfaceEl = document.getElementById('reader-surface');
    surfaceEl.innerHTML = '';
    orientation = opts.orientation || 'horizontal';
    theme = opts.theme || 'light';
    callbacks = opts.callbacks || {};
    mode = book.format;

    if (mode === 'pdf') {
      await openPdf(book);
    } else {
      await openEpub(book);
    }
    applyOrientationClass();
  }

  function applyOrientationClass() {
    surfaceEl.classList.toggle('vertical-mode', orientation === 'vertical');
    document.getElementById('reader-body').classList.toggle('vertical-mode-active', orientation === 'vertical');
  }

  // ---------------- PDF ----------------
  async function openPdf(book) {
    const arrayBuffer = await book.fileBlob.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    pageCount = pdfDoc.numPages;
    pageNum = Math.min(Math.max(parseInt(book.currentLocation) || 1, 1), pageCount);

    if (orientation === 'horizontal') {
      await renderPdfHorizontal();
    } else {
      await renderPdfVertical();
    }
  }

  async function renderPdfHorizontal() {
    surfaceEl.innerHTML = '';
    const page = await pdfDoc.getPage(pageNum);
    const containerWidth = surfaceEl.clientWidth * 0.9;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min((containerWidth) / baseViewport.width, (surfaceEl.clientHeight * 0.92) / baseViewport.height);
    const viewport = page.getViewport({ scale: scale > 0 ? scale : 1 });
    const canvas = document.createElement('canvas');
    surfaceEl.appendChild(canvas);
    await renderPageToCanvas(page, viewport, canvas);

    const fraction = pageNum / pageCount;
    fireProgress(fraction, pageNum >= pageCount, String(pageNum));
  }

  async function renderPdfVertical() {
    surfaceEl.innerHTML = '';
    if (pdfObserver) pdfObserver.disconnect();

    const firstPage = await pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const width = surfaceEl.clientWidth * 0.9;
    const scale = width / baseViewport.width;

    const placeholders = [];
    for (let i = 1; i <= pageCount; i++) {
      const div = document.createElement('div');
      div.className = 'pdf-page-placeholder';
      div.dataset.pageNum = String(i);
      div.style.width = width + 'px';
      div.style.height = (baseViewport.height * scale) + 'px';
      div.style.margin = '12px auto';
      div.style.background = '#fafafa';
      surfaceEl.appendChild(div);
      placeholders.push(div);
    }

    pdfObserver = new IntersectionObserver(async (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const div = entry.target;
        const n = parseInt(div.dataset.pageNum, 10);
        if (div.dataset.rendered) continue;
        div.dataset.rendered = '1';
        const p = await pdfDoc.getPage(n);
        const vp = p.getViewport({ scale });
        const canvas = document.createElement('canvas');
        div.style.width = '';
        div.style.height = '';
        div.appendChild(canvas);
        await renderPageToCanvas(p, vp, canvas);

        pageNum = n;
        const fraction = n / pageCount;
        const nearBottom = surfaceEl.scrollTop + surfaceEl.clientHeight >= surfaceEl.scrollHeight - 60;
        fireProgress(fraction, n >= pageCount && nearBottom, String(n));
      }
    }, { root: surfaceEl, rootMargin: '400px 0px' });

    placeholders.forEach(p => pdfObserver.observe(p));

    const target = placeholders[pageNum - 1];
    if (target) target.scrollIntoView({ block: 'start' });
  }

  async function pdfNext() {
    if (orientation === 'vertical') {
      surfaceEl.scrollBy({ top: surfaceEl.clientHeight * 0.9, behavior: 'smooth' });
      return;
    }
    if (pageNum >= pageCount) return;
    pageNum++;
    await renderPdfHorizontal();
  }

  async function pdfPrev() {
    if (orientation === 'vertical') {
      surfaceEl.scrollBy({ top: -surfaceEl.clientHeight * 0.9, behavior: 'smooth' });
      return;
    }
    if (pageNum <= 1) return;
    pageNum--;
    await renderPdfHorizontal();
  }

  // ---------------- EPUB ----------------
  async function openEpub(book) {
    const arrayBuffer = await book.fileBlob.arrayBuffer();
    epubBook = ePub(arrayBuffer);
    await buildEpubRendition(book.currentLocation);

    epubBook.ready.then(() => {
      epubBook.locations.generate(1600)
        .then(() => { locationsReady = true; })
        .catch((e) => console.error('EPUB locations generation failed', e));
    });
  }

  async function buildEpubRendition(startCfi) {
    if (epubRendition) epubRendition.destroy();
    surfaceEl.innerHTML = '';
    epubRendition = epubBook.renderTo(surfaceEl, {
      width: '100%',
      height: '100%',
      flow: orientation === 'horizontal' ? 'paginated' : 'scrolled-doc',
      manager: orientation === 'horizontal' ? 'default' : 'continuous'
    });

    epubRendition.themes.register('light', { body: { background: '#ffffff', color: '#141414' } });
    epubRendition.themes.register('sepia', { body: { background: '#f4ecd8', color: '#3a2f22' } });
    epubRendition.themes.register('dark', { body: { background: '#1a1a1a', color: '#eaeaea' } });
    epubRendition.themes.select(theme);

    epubRendition.on('relocated', (location) => {
      let fraction = 0;
      if (locationsReady) {
        fraction = epubBook.locations.percentageFromCfi(location.start.cfi);
      } else if (epubBook.spine && epubBook.spine.length) {
        fraction = location.start.index / epubBook.spine.length;
      }
      fireProgress(fraction, !!location.atEnd, location.start.cfi);
    });

    await epubRendition.display(startCfi || undefined);
  }

  function epubNext() { if (epubRendition) epubRendition.next(); }
  function epubPrev() { if (epubRendition) epubRendition.prev(); }

  // ---------------- Shared API ----------------
  function next() { mode === 'pdf' ? pdfNext() : epubNext(); }
  function prev() { mode === 'pdf' ? pdfPrev() : epubPrev(); }

  async function setOrientation(newOrientation) {
    if (orientation === newOrientation) return;
    orientation = newOrientation;
    applyOrientationClass();
    if (mode === 'pdf') {
      orientation === 'horizontal' ? await renderPdfHorizontal() : await renderPdfVertical();
    } else {
      const cfi = (epubRendition && epubRendition.location) ? epubRendition.location.start.cfi : undefined;
      await buildEpubRendition(cfi);
    }
  }

  function setTheme(newTheme) {
    theme = newTheme;
    if (mode === 'epub' && epubRendition) epubRendition.themes.select(theme);
  }

  function close() {
    if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
    if (epubRendition) { epubRendition.destroy(); epubRendition = null; }
    if (epubBook) { epubBook.destroy(); epubBook = null; }
    pdfDoc = null;
    locationsReady = false;
    mode = null;
  }

  function getOrientation() { return orientation; }

  return { open, next, prev, setOrientation, setTheme, close, getOrientation };
})();
