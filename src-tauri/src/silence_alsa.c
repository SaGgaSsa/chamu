#include <alsa/asoundlib.h>

/*
 * Discards ALSA library diagnostics. cpal probes every PCM in both
 * directions to classify it, which makes ALSA print expected failures
 * (a playback-only `dmix` tried as capture, and so on) to stderr.
 * Real errors still surface through cpal's own API.
 */
static void chamu_discard_alsa_error(
    const char *file,
    int line,
    const char *function,
    int error,
    const char *format,
    ...
) {
    (void)file;
    (void)line;
    (void)function;
    (void)error;
    (void)format;
}

void chamu_silence_alsa_messages(void) {
    snd_lib_error_set_handler(chamu_discard_alsa_error);
}