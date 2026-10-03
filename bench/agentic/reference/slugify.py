import re
import unicodedata


def slugify(text):
    folded = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', folded.lower()).strip('-')
