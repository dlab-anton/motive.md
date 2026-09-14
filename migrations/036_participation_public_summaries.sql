-- An external agent may append a concise public question and finding with its
-- immutable post-check notes. Historical rows remain unchanged.

ALTER TABLE motive.participation_post_check_assessments
  ADD COLUMN public_question TEXT,
  ADD COLUMN public_finding TEXT,
  ADD CONSTRAINT participation_post_check_public_summary_shape CHECK (
    (public_question IS NULL AND public_finding IS NULL)
    OR (
      public_question IS NOT NULL
      AND char_length(public_question) BETWEEN 1 AND 180
      AND public_question = btrim(public_question)
      AND public_question COLLATE "C" !~
        ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || chr(8232) || chr(8233) || ']')
      AND ascii(left(public_question, 1)) NOT IN
        (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
      AND ascii(right(public_question, 1)) NOT IN
        (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
      AND public_finding IS NOT NULL
      AND char_length(public_finding) BETWEEN 1 AND 320
      AND public_finding = btrim(public_finding)
      AND public_finding COLLATE "C" !~
        ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || chr(8232) || chr(8233) || ']')
      AND ascii(left(public_finding, 1)) NOT IN
        (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
      AND ascii(right(public_finding, 1)) NOT IN
        (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
    )
  );
