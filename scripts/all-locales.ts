// #662: the interface loads the language it does not show on demand (web/lib/messages.ts, loadLocale). A test that
// reads both languages imports this file: every table is loaded before its first test runs.
import { before } from 'node:test'
import { LOCALES, loadLocale } from '../web/lib/messages'

before(() => Promise.all(LOCALES.map(loadLocale)))
