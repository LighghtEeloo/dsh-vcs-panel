/**
 * UI dictionaries for the version control panel.
 *
 * Keys live in one flat frozen module per language under `locales/`; missing
 * locales fall back to English through the Host locale service. Display
 * metadata lives in `locale/*.json`.
 */

import en from './locales/en.js'
import zh from './locales/zh.js'
import ja from './locales/ja.js'
import es from './locales/es.js'
import fr from './locales/fr.js'
import de from './locales/de.js'
import ru from './locales/ru.js'
import pt from './locales/pt.js'

/** Dictionary set keyed by locale id. */
export const DICTIONARIES = Object.freeze({ en, zh, ja, es, fr, de, ru, pt })
