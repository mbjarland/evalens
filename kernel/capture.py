"""Bounded statement output, independent of the complete live output stream."""
import io
import threading


OUTPUT_LIMIT = 65536


class OutputCapture:
    def __init__(self, limit=OUTPUT_LIMIT, prompt_limit=500):
        self._limit = limit
        self._prompt_limit = prompt_limit
        self._prefix = io.StringIO()
        self._kept = 0
        self._total = 0
        self._tail = ""
        self._lock = threading.Lock()

    def write(self, text):
        with self._lock:
            keep = min(len(text), self._limit - self._kept)
            if keep:
                self._prefix.write(text[:keep])
                self._kept += keep
            self._total += len(text)
            # Prompt lookup never copies/scans the accumulated transcript.
            # Keep one extra character so the caller can mark truncation.
            newline = text.rfind("\n")
            if newline >= 0:
                self._tail = text[newline + 1:newline + self._prompt_limit + 2]
            else:
                room = max(0, self._prompt_limit + 1 - len(self._tail))
                self._tail += text[:room]
        return len(text)

    def getvalue(self):
        with self._lock:
            value = self._prefix.getvalue()
            omitted = self._total - self._kept
            if omitted:
                value += f"\n… <{omitted:,} characters omitted from trace>\n"
            return value

    def tail(self):
        with self._lock:
            return self._tail

    def offset(self):
        """Original-stream character position, even after capture is full."""
        with self._lock:
            return self._total

    def retained(self):
        """Characters retained before getvalue's synthetic omission note."""
        with self._lock:
            return self._kept
