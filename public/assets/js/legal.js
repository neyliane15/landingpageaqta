// Páginas legais: preenche o canal de WhatsApp da Aqta (vindo de /api/catalog → support), se houver.
import { loadSupport, applySupportLinks } from './support.js';

loadSupport().then(() => applySupportLinks(document));
