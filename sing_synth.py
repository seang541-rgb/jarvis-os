import json
import struct
import math
import io
import sys

SAMPLE_RATE = 24000
DURATION = 0.3

NOTE_FREQ = {
    'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23,
    'G4': 392.00, 'A4': 440.00, 'B4': 493.88,
    'C5': 523.25, 'D5': 587.33, 'E5': 659.25, 'F5': 698.46,
    'G5': 783.99, 'A5': 880.00, 'B5': 987.77,
}

def generate_tone(freq, duration, sample_rate=24000):
    samples = int(sample_rate * duration)
    data = []
    for i in range(samples):
        t = i / sample_rate
        envelope = min(1.0, min(t / 0.02, (duration - t) / 0.05))
        val = math.sin(2 * math.pi * freq * t) * 0.3 * envelope
        val += math.sin(2 * math.pi * freq * 2 * t) * 0.1 * envelope
        val += math.sin(2 * math.pi * freq * 3 * t) * 0.05 * envelope
        data.append(int(max(-32767, min(32767, val * 32767))))
    return data

def write_wav(filename, samples, sample_rate=24000):
    with open(filename, 'wb') as f:
        data_size = len(samples) * 2
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVE')
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16))
        f.write(struct.pack('<HHIIHH', 1, 1, sample_rate, sample_rate * 2, 2, 16))
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        for s in samples:
            f.write(struct.pack('<h', s))

def sing_melody(notes, output_file):
    samples = []
    for note, dur in notes:
        if note == 'R':
            samples.extend([0] * int(SAMPLE_RATE * dur))
        else:
            freq = NOTE_FREQ.get(note, 440)
            samples.extend(generate_tone(freq, dur))
    write_wav(output_file, samples)

SONGS = {
    '小幸运': [
        ('E4', 0.4), ('E4', 0.4), ('G4', 0.4), ('A4', 0.4),
        ('G4', 0.4), ('E4', 0.4), ('D4', 0.4), ('C4', 0.4),
        ('D4', 0.4), ('E4', 0.4), ('G4', 0.4), ('A4', 0.6),
        ('G4', 0.4), ('E4', 0.4), ('D4', 0.6), ('R', 0.2),
        ('C4', 0.4), ('D4', 0.4), ('E4', 0.4), ('G4', 0.4),
        ('A4', 0.4), ('G4', 0.4), ('E4', 0.6), ('R', 0.2),
    ],
    '晴天': [
        ('E4', 0.3), ('G4', 0.3), ('A4', 0.3), ('G4', 0.3),
        ('E4', 0.3), ('D4', 0.3), ('C4', 0.5), ('R', 0.2),
        ('C4', 0.3), ('D4', 0.3), ('E4', 0.3), ('G4', 0.3),
        ('A4', 0.3), ('G4', 0.3), ('E4', 0.5), ('R', 0.2),
        ('A4', 0.3), ('G4', 0.3), ('E4', 0.3), ('D4', 0.3),
        ('C4', 0.3), ('D4', 0.3), ('E4', 0.5), ('R', 0.2),
    ],
    '稻香': [
        ('G4', 0.3), ('A4', 0.3), ('B4', 0.3), ('A4', 0.3),
        ('G4', 0.3), ('E4', 0.3), ('D4', 0.5), ('R', 0.2),
        ('D4', 0.3), ('E4', 0.3), ('G4', 0.3), ('A4', 0.3),
        ('G4', 0.3), ('E4', 0.3), ('D4', 0.5), ('R', 0.2),
        ('G4', 0.3), ('A4', 0.3), ('B4', 0.3), ('D5', 0.3),
        ('B4', 0.3), ('A4', 0.3), ('G4', 0.5), ('R', 0.2),
    ],
}

if __name__ == '__main__':
    song_name = sys.argv[1] if len(sys.argv) > 1 else '小幸运'
    output = sys.argv[2] if len(sys.argv) > 2 else 'song_output.wav'
    if song_name in SONGS:
        sing_melody(SONGS[song_name], output)
        print(f'Generated: {output}')
    else:
        print(f'Unknown song: {song_name}')
        print(f'Available: {", ".join(SONGS.keys())}')
