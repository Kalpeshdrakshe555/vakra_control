export type BrainReplyType =
    | 'FIX'
    | 'PLAN'
    | 'NEED_FILES'
    | 'NEED_COMMAND'
    | 'ASK_USER'
    | 'DIAGNOSIS'
    | 'UNKNOWN';

export const PROTOCOL_MARKERS = {
    TYPE_PREFIX: 'TYPE:',
    STEP_PREFIX: 'STEP:',
    MANIFEST_PREFIX: 'MANIFEST:',
    FILE_START: '===FILE:',
    FILE_END: '===END FILE===',
    EDIT_START: '===EDIT:',
    EDIT_END: '===END EDIT===',
    COMMANDS_START: '===COMMANDS===',
    COMMANDS_END: '===END COMMANDS===',
    VERIFY_START: '===VERIFY===',
    VERIFY_END: '===END VERIFY===',
    NEXT_PLANNED_PREFIX: 'NEXT_PLANNED:',
    END_OF_RESPONSE: '===END OF RESPONSE===',
    SEARCH_START: '<<<<<<< SEARCH',
    SEARCH_DIVIDER: '=======',
    REPLACE_END: '>>>>>>> REPLACE'
} as const;
