import { Redirect } from 'expo-router'

// PearTune is ONE screen: `app/index.tsx`, a WebView holding the whole UI. Nothing
// else is a route, so nothing should ever be able to route away from it - and yet a
// `pear://peartune/pair?...` deep link did exactly that, because expo-router had no
// match for host `peartune` + path `/pair` and fell through to its built-in
// "Unmatched Route" debug screen, URL and all, on Android AND iOS, warm or cold
// (Tim, 2026-07-26).
//
// This is the backstop half of the fix. The link itself is now read as DATA by the
// shell (see the deep-links block in index.tsx) and handed to the UI's pairing flow;
// this makes sure that whatever the router does with the URL, where it LANDS is the
// app. Any future unmatched path gets the same treatment for free.
export default function NotFound () {
  return <Redirect href='/' />
}
