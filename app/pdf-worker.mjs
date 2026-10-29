// pdf.js worker entry: install the compatibility fills (see compat.js) before the unmodified
// pdf.js worker module runs. Imports evaluate in order, so compat.js runs first.
import './compat.js';
import '../vendor/pdfjs/pdf.worker.min.mjs';
