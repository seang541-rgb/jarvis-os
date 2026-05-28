import math
import struct
import sys

SAMPLE_RATE = 24000

NOTE_FREQ = {
    "C4": 261.63, "D4": 293.66, "E4": 329.63, "F4": 349.23,
    "G4": 392.00, "A4": 440.00, "B4": 493.88,
    "C5": 523.25, "D5": 587.33, "E5": 659.25, "F5": 698.46,
    "G5": 783.99, "A5": 880.00, "B5": 987.77,
}

VOWELS = {
    "a": [(800, 1.00), (1150, 0.55), (2800, 0.22)],
    "i": [(300, 0.90), (2200, 0.62), (3000, 0.25)],
    "u": [(350, 0.90), (900, 0.48), (2400, 0.20)],
    "e": [(500, 0.90), (1700, 0.52), (2500, 0.22)],
    "o": [(500, 0.90), (1000, 0.50), (2600, 0.20)],
}

SONGS = {
    "小幸运": [
        ("E4", 0.46, "a"), ("E4", 0.38, "i"), ("G4", 0.42, "a"), ("A4", 0.52, "o"),
        ("G4", 0.42, "a"), ("E4", 0.42, "e"), ("D4", 0.42, "i"), ("C4", 0.56, "a"),
        ("D4", 0.42, "u"), ("E4", 0.42, "a"), ("G4", 0.42, "i"), ("A4", 0.68, "a"),
        ("G4", 0.42, "o"), ("E4", 0.42, "e"), ("D4", 0.62, "a"), ("R", 0.16, "a"),
        ("C4", 0.42, "a"), ("D4", 0.42, "i"), ("E4", 0.46, "a"), ("G4", 0.46, "o"),
        ("A4", 0.46, "a"), ("G4", 0.46, "e"), ("E4", 0.72, "a"),
    ],
    "晴天": [
        ("E4", 0.34, "a"), ("G4", 0.34, "i"), ("A4", 0.38, "a"), ("G4", 0.34, "e"),
        ("E4", 0.34, "o"), ("D4", 0.34, "a"), ("C4", 0.54, "u"), ("R", 0.14, "a"),
        ("C4", 0.34, "a"), ("D4", 0.34, "i"), ("E4", 0.34, "a"), ("G4", 0.38, "e"),
        ("A4", 0.38, "o"), ("G4", 0.36, "a"), ("E4", 0.58, "i"), ("R", 0.14, "a"),
        ("A4", 0.34, "a"), ("G4", 0.34, "e"), ("E4", 0.34, "i"), ("D4", 0.34, "o"),
        ("C4", 0.34, "a"), ("D4", 0.34, "u"), ("E4", 0.62, "a"),
    ],
    "稻香": [
        ("G4", 0.34, "a"), ("A4", 0.34, "o"), ("B4", 0.34, "i"), ("A4", 0.34, "a"),
        ("G4", 0.34, "e"), ("E4", 0.34, "u"), ("D4", 0.54, "a"), ("R", 0.14, "a"),
        ("D4", 0.34, "a"), ("E4", 0.34, "i"), ("G4", 0.34, "a"), ("A4", 0.38, "o"),
        ("G4", 0.34, "e"), ("E4", 0.34, "a"), ("D4", 0.58, "u"), ("R", 0.14, "a"),
        ("G4", 0.34, "a"), ("A4", 0.34, "i"), ("B4", 0.34, "a"), ("D5", 0.40, "e"),
        ("B4", 0.34, "o"), ("A4", 0.34, "a"), ("G4", 0.68, "a"),
    ],
}


def envelope(t, duration):
    attack = min(0.08, duration * 0.24)
    release = min(0.12, duration * 0.30)
    if t < attack:
        return t / attack
    if t > duration - release:
        return max(0.0, (duration - t) / release)
    return 1.0


def formant_gain(freq, vowel):
    gain = 0.0
    for center, amount in VOWELS[vowel]:
        width = center * 0.18
        gain += amount * math.exp(-((freq - center) ** 2) / (2 * width * width))
    return max(0.03, gain)


def sing_note(note, duration, vowel):
    if note == "R":
        return [0] * int(SAMPLE_RATE * duration)

    base = NOTE_FREQ[note]
    total = int(SAMPLE_RATE * duration)
    samples = []

    for i in range(total):
        t = i / SAMPLE_RATE
        env = envelope(t, duration)
        vibrato = 1 + 0.012 * math.sin(2 * math.pi * 5.4 * t)
        freq = base * vibrato

        value = 0.0
        for harmonic in range(1, 14):
            harmonic_freq = freq * harmonic
            amp = (1.0 / harmonic) * formant_gain(harmonic_freq, vowel)
            value += math.sin(2 * math.pi * harmonic_freq * t) * amp

        breath = math.sin(2 * math.pi * 7200 * t) * 0.012
        value = math.tanh((value * 0.65 + breath) * 1.6)
        samples.append(value * env * 0.42)

    return samples


def add_backing(samples, melody, volume=0.08):
    cursor = 0
    for note, duration, _vowel in melody:
        total = int(SAMPLE_RATE * duration)
        if note != "R":
            base = NOTE_FREQ[note] / 2
            for i in range(total):
                if cursor + i >= len(samples):
                    break
                t = i / SAMPLE_RATE
                env = envelope(t, duration)
                chord = (
                    math.sin(2 * math.pi * base * t)
                    + 0.45 * math.sin(2 * math.pi * base * 1.5 * t)
                    + 0.35 * math.sin(2 * math.pi * base * 2 * t)
                )
                samples[cursor + i] += chord * env * volume
        cursor += total


def normalize(samples):
    peak = max(0.001, max(abs(s) for s in samples))
    return [max(-0.98, min(0.98, s / peak * 0.88)) for s in samples]


def write_wav(filename, samples):
    samples = normalize(samples)
    with open(filename, "wb") as f:
        data_size = len(samples) * 2
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + data_size))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", 16))
        f.write(struct.pack("<HHIIHH", 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", data_size))
        for s in samples:
            f.write(struct.pack("<h", int(s * 32767)))


def synthesize(song_name, output_file):
    melody = SONGS[song_name]
    samples = []
    for note, duration, vowel in melody:
        samples.extend(sing_note(note, duration, vowel))

    add_backing(samples, melody)
    write_wav(output_file, samples)


if __name__ == "__main__":
    song_name = sys.argv[1] if len(sys.argv) > 1 else "小幸运"
    output = sys.argv[2] if len(sys.argv) > 2 else "song_output.wav"

    if song_name not in SONGS:
        print(f"Unknown song: {song_name}")
        print(f"Available: {', '.join(SONGS.keys())}")
        sys.exit(1)

    synthesize(song_name, output)
    print(f"Generated: {output}")
