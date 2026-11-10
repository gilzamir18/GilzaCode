import gzip
import os
import math

class SynctexParser:
    def __init__(self, synctex_path):
        self.synctex_path = synctex_path
        self.inputs = {}  # tag -> filename
        self.nodes = []   # list of dicts: {'tag': tag, 'line': line, 'page': page, 'x': x, 'y': y, 'type': node_type}
        self._parse()

    def _parse(self):
        if not os.path.exists(self.synctex_path):
            return
            
        try:
            with gzip.open(self.synctex_path, 'rt', encoding='utf-8') as f:
                content = f.read()
        except Exception:
            return

        lines = content.split('\n')
        current_page = 1
        
        for line in lines:
            if not line:
                continue
                
            if line.startswith('Input:'):
                parts = line.split(':', 2)
                if len(parts) == 3:
                    tag = parts[1]
                    filename = parts[2].strip()
                    self.inputs[tag] = filename
            elif line.startswith('{'):
                # Page start
                try:
                    current_page = int(line[1:].strip())
                except:
                    pass
            elif line[0] in ('h', 'v', 'x', 'g', 'k', 'f', 'r', 'm', '(', '['):
                    # node: type tag,line:x,y:W,H,D
                    parts = line[1:].split(':')
                    if len(parts) >= 2:
                        tag_line = parts[0].split(',')
                        if len(tag_line) == 2:
                            tag = tag_line[0] # keep as string to match parser.inputs
                            source_line = int(tag_line[1])
                            coords = parts[1].split(',')
                            if len(coords) >= 2:
                                try:
                                    x = int(coords[0]) / 65536.0
                                    y = int(coords[1]) / 65536.0
                                    w = 0
                                    h = 0
                                    if len(parts) >= 3:
                                        dims = parts[2].split(',')
                                        if len(dims) >= 2:
                                            w = int(dims[0]) / 65536.0
                                            h = int(dims[1]) / 65536.0
                                    
                                    self.nodes.append({
                                        'tag': tag,
                                        'line': source_line,
                                        'page': current_page,
                                        'x': x,
                                        'y': y,
                                        'w': w,
                                        'h': h,
                                        'type': line[0]
                                    })
                                except:
                                    pass

def companion_synctex_path(pdf_path):
    """Return the SyncTeX file written alongside `pdf_path`, or "" if none.

    TeX engines name it after the PDF (`paper.pdf` -> `paper.synctex.gz`), so a
    PDF without that sibling was not produced with SyncTeX and has no source.
    """
    candidate = os.path.splitext(pdf_path)[0] + ".synctex.gz"
    return candidate if os.path.isfile(candidate) else ""


def select_record_line(recorded_lines, target_line):
    """Picks which recorded source line covers `target_line`.

    A SyncTeX record carries the line that was current when TeX *shipped* the
    material out, not necessarily the line the material was written on. Anything
    collected into a box and typeset later -- a beamer frame body above all, whose
    whole content is emitted at ``\\end{frame}`` -- is therefore recorded under a
    line at or *after* the one the user edited.

    So when the target line has no record of its own, the record that covers it is
    the next one, never the previous one. Choosing the numerically nearest line
    instead sends the first half of every beamer frame to the slide before it: for
    a frame spanning lines 9-15, line 10 is closer to the preceding frame's record
    (line 7) than to its own (line 15).

    Only when nothing follows the target -- a click past the last typeset line --
    does the closest earlier record win.
    """
    if not recorded_lines:
        return None
    at_or_after = [line for line in recorded_lines if line >= target_line]
    if at_or_after:
        return min(at_or_after)
    return max(recorded_lines)


def find_pdf_position(synctex_path, target_file, target_line):
    """Finds the first node matching the target file and line."""
    parser = SynctexParser(synctex_path)
    
    target_basename = os.path.basename(target_file)
    target_tag = None
    for tag, filename in parser.inputs.items():
        if os.path.basename(filename) == target_basename:
            target_tag = tag
            break
            
    if not target_tag:
        return None
        
    file_nodes = [node for node in parser.nodes if node['tag'] == target_tag]
    best_line = select_record_line({node['line'] for node in file_nodes}, target_line)
    if best_line is None:
        return None

    best_nodes = [node for node in file_nodes if node['line'] == best_line]
    if not best_nodes:
        return None
    
    # Aggregate to find paragraph bounding box using ONLY text nodes ('h', 'x') to avoid glues ('g', 'k') expanding the box too much
    text_nodes = [n for n in best_nodes if n['type'] in ('h', 'x')]
    if not text_nodes:
        text_nodes = best_nodes # fallback if no text nodes
        
    
    
    # Group text nodes by page
    page_counts = {}
    for n in text_nodes:
        p = n['page']
        page_counts[p] = page_counts.get(p, 0) + 1
        
    # Find the page with the most nodes (the actual text, not ToC or headers).
    # A beamer frame with \pause is shipped once per overlay, with every box
    # present on every one of them, so its pages tie here; the -k term breaks
    # that tie towards the first overlay rather than leaving it to node order.
    if not page_counts:
        return None
        
    best_page = max(page_counts.keys(), key=lambda k: (page_counts[k], -k))
    
    # Filter nodes to ONLY those on the best_page
    page_nodes = [n for n in text_nodes if n['page'] == best_page]
    
    # Filter out structural boxes by ensuring width > 20pt (actual text lines are wide)
    text_line_nodes = [n for n in page_nodes if n.get('w', 0) > 20]
    if not text_line_nodes:
        text_line_nodes = page_nodes

    # Use median Y to avoid outliers on this specific page
    y_values = sorted([n['y'] for n in text_line_nodes])
    if y_values:
        median_y = y_values[len(y_values) // 2]
        # Filter nodes that are roughly on the same paragraph
        valid_nodes = [n for n in text_line_nodes if abs(n['y'] - median_y) < 150]
        if not valid_nodes: valid_nodes = text_line_nodes
    else:
        valid_nodes = text_line_nodes
        
    min_y = min([n['y'] for n in valid_nodes], default=best_nodes[0]['y'])
    max_y = max([n['y'] for n in valid_nodes], default=best_nodes[0]['y'])
    min_x = min([n['x'] for n in valid_nodes], default=best_nodes[0]['x'])
    
    # Calculate height. We use max_y - min_y. If they are on the same line, height is fallback 12.
    # Note: y is usually baseline. Top is min_y - 10, Bottom is max_y + 2
    
    page = valid_nodes[0]['page'] if valid_nodes else best_nodes[0]['page']
    
    # Let's find the maximum width based on valid nodes
    max_right = max([n['x'] + (n.get('w', 0) or 0) for n in valid_nodes], default=min_x + 10)
    w = max_right - min_x
    
    # The height is the difference in baselines + an approximation for text height
    h = max_y - min_y + 12
    
    return {
        'page': page,
        'x': min_x,
        'y': min_y - 10, # Adjust y so the box starts ABOVE the baseline
        'w': w,
        'h': h
    }

class GeneratedSourceError(Exception):
    """The clicked material was read from a file TeX generated during the run.

    Such a file has no source of its own to open. Reporting that is the
    contract; opening the (empty or overwritten) generated file is not.
    """


def _is_generated_input(filename):
    """A beamer fragile-frame file, or a file the engine did not name.

    Beamer writes the body of every ``fragile`` frame to ``\\jobname.vrb`` and
    reads it back with ``\\input``, so the frame's material is recorded against
    that file. Tectonic keeps the file in memory and records it with an *empty*
    name; pdfTeX names it, but the file on disk only holds the last fragile
    frame of the run. Neither is the frame's source.
    """
    return not filename or filename.lower().endswith('.vrb')


_FRAME_BEGIN = '\\begin{frame}'
_FRAME_END = '\\end{frame}'


def _skip_space(text, pos):
    """Skips what TeX's ``\\@ifnextchar`` skips: spaces, one end of line, comments.

    Stops at a blank line, which TeX turns into ``\\par`` rather than a space.
    """
    newlines = 0
    while pos < len(text):
        char = text[pos]
        if char in ' \t':
            pos += 1
        elif char == '%':
            end = text.find('\n', pos)
            pos = len(text) if end < 0 else end + 1
        elif char == '\n':
            if newlines:
                return pos - 1
            newlines += 1
            pos += 1
        else:
            break
    return pos


def _balanced_end(text, pos, opener, closer):
    """Index just past the group opened at `pos`, or -1 if it never closes."""
    depth = 0
    index = pos
    while index < len(text):
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return -1


def _is_fragile(options):
    """``fragile`` (or ``fragile=true``) sends the frame through a .vrb file.

    ``fragile=singleslide`` keeps the body in memory instead, so it does not.
    """
    for option in options.split(','):
        key, _, value = option.partition('=')
        if key.strip() == 'fragile' and value.strip() in ('', 'true'):
            return True
    return False


def _fragile_frames(text):
    """Yields each fragile frame as ``(header_line, first_body, end_line)``.

    `header_line` is the line on which the frame header (overlay spec, options
    and title arguments) ends, `first_body` a pair ``(vrb_line, source_line)``
    locating the first body line in both files, and `end_line` the line of the
    frame's ``\\end{frame}``. Lines are 1-based.

    What beamer writes (beamerbaseframe.sty / beamerbaseverbatim.sty): a frame
    with one title argument starts the .vrb with a ``\\frametitle{...}`` line of
    its own; with a title and a subtitle, the two are written on the first line
    together with the rest of the header line; with no title, nothing is added.
    Each following source line up to ``\\end{frame}`` is copied one for one.

    Except for the lines TeX's own look-ahead consumed: when the header ends its
    line with no title, or with a title alone, ``\\@ifnextchar`` tokenizes past
    the end of that line before the verbatim reader takes over, so comment-only
    lines there are dropped and never reach the file.
    """
    lines = text.split('\n')
    search = 0
    while True:
        begin = text.find(_FRAME_BEGIN, search)
        if begin < 0:
            return
        search = begin + len(_FRAME_BEGIN)
        line_start = text.rfind('\n', 0, begin) + 1
        if '%' in text[line_start:begin]:
            continue
        pos = search
        options = ''
        while True:
            peek = _skip_space(text, pos)
            if peek < len(text) and text[peek] in '<[':
                closer = '>' if text[peek] == '<' else ']'
                end = _balanced_end(text, peek, text[peek], closer)
                if end < 0:
                    break
                if closer == ']':
                    options += ',' + text[peek + 1:end - 1]
                pos = end
                continue
            break
        titles = 0
        while titles < 2:
            peek = _skip_space(text, pos)
            if peek >= len(text) or text[peek] != '{':
                break
            end = _balanced_end(text, peek, '{', '}')
            if end < 0:
                break
            pos = end
            titles += 1
        end_frame = text.find(_FRAME_END, pos)
        if end_frame < 0:
            return
        if not _is_fragile(options):
            continue
        header_line = text.count('\n', 0, pos) + 1
        line_end = text.find('\n', pos)
        rest = text[pos:line_end if line_end >= 0 else len(text)].strip()
        trailing = bool(rest) and not rest.startswith('%')
        if titles == 1:
            first_vrb = 3 if trailing else 2
        elif titles == 2:
            first_vrb = 2
        else:
            first_vrb = 2 if trailing else 1
        first_source = header_line + 1
        if titles < 2 and not trailing:
            while first_source <= len(lines) and lines[first_source - 1].lstrip().startswith('%'):
                first_source += 1
        yield header_line, (first_vrb, first_source), text.count('\n', 0, end_frame) + 1


def _vrb_line_to_source(vrb_line, header_line, first_body):
    """Maps a line of beamer's .vrb file back to the frame's source line."""
    first_vrb, first_source = first_body
    if vrb_line < first_vrb:
        return header_line
    return first_source + (vrb_line - first_vrb)


def _resolve_generated_node(parser, node):
    """Resolves a node read from a beamer .vrb file to its frame's source line.

    The frame is found through the record beamer leaves in the real source: the
    whole frame is shipped out at ``\\end{frame}``, so the page carries a node
    on that line of the file that holds the frame.
    """
    anchors = {}
    for other in parser.nodes:
        if other['page'] != node['page']:
            continue
        filename = parser.inputs.get(other['tag'], '')
        if _is_generated_input(filename):
            continue
        anchors.setdefault(filename, set()).add(other['line'])

    for filename, lines in anchors.items():
        source_path = filename
        if not os.path.isabs(source_path):
            source_path = os.path.join(os.path.dirname(parser.synctex_path), source_path)
        try:
            with open(source_path, 'r', encoding='utf-8', errors='replace') as handle:
                text = handle.read()
        except OSError:
            continue
        for header_line, first_body, end_line in _fragile_frames(text):
            if end_line not in lines:
                continue
            line = _vrb_line_to_source(node['line'], header_line, first_body)
            return {'file': filename, 'line': min(line, end_line)}

    raise GeneratedSourceError(
        'The clicked text was read from a file generated during compilation '
        '(not a beamer fragile frame of this document), so it has no source line.'
    )


def find_source_line(synctex_path, page, x, y):
    """Finds the source file and line closest to the PDF coordinates.

    Raises GeneratedSourceError when the closest material came from a file the
    compilation generated and it cannot be traced back to the source.
    """
    parser = SynctexParser(synctex_path)

    best_node = None
    min_dist = float('inf')

    for node in parser.nodes:
        if node['page'] == page:
            dx = node['x'] - x
            dy = node['y'] - y
            dist = dx*dx + (dy*dy * 4) # weight Y

            if dist < min_dist:
                min_dist = dist
                best_node = node

    if best_node and best_node['tag'] in parser.inputs:
        filename = parser.inputs[best_node['tag']]
        if _is_generated_input(filename):
            return _resolve_generated_node(parser, best_node)
        return {
            'file': filename,
            'line': best_node['line']
        }
    return None
